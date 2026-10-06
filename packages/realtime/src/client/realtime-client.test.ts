import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";

import { defined } from "../defined.test-helpers.js";
import { defineParsers } from "./postgres/parsers.js";
import {
	createRealtimeClient,
	type MaterializedLiveQuerySubscription,
	type RawLiveQuerySubscription,
} from "./realtime-client.js";
import type { SealedLiveQuery } from "./sealed-query.js";

interface MessageRow {
	readonly id: number;
	readonly title: string;
}

const QUERY_FINGERPRINT = "11".repeat(32);
const ROW_KEY = "a".repeat(64);
const ROW_KEY_B = "b".repeat(64);
const ROW_KEY_C = "c".repeat(64);

type FakeWebSocketListener =
	| (() => void)
	| ((event: { readonly data: unknown }) => void);

class FakeWebSocket {
	static instances: FakeWebSocket[] = [];
	readyState = 0;
	readonly sent: Record<string, unknown>[] = [];
	readonly protocols: string | string[];
	private readonly listeners = new Map<string, Set<FakeWebSocketListener>>();

	constructor(_url: string, protocols: string | string[]) {
		this.protocols = protocols;
		FakeWebSocket.instances.push(this);
	}

	addEventListener(type: "open", listener: () => void): void;
	addEventListener(
		type: "message",
		listener: (event: { readonly data: unknown }) => void,
	): void;
	addEventListener(type: "close", listener: () => void): void;
	addEventListener(type: "error", listener: () => void): void;
	addEventListener(type: string, listener: FakeWebSocketListener): void {
		const listeners = this.listeners.get(type) ?? new Set();
		listeners.add(listener);
		this.listeners.set(type, listeners);
	}

	send(data: string): void {
		this.sent.push(JSON.parse(data));
	}

	close(): void {
		if (this.readyState >= 2) return;
		this.readyState = 3;
		this.emit("close", {});
	}

	open(): void {
		this.readyState = 1;
		this.emit("open", {});
	}

	receive(message: object): void {
		this.emit("message", { data: JSON.stringify(message) });
	}

	private emit(type: string, event: unknown): void {
		for (const listener of this.listeners.get(type) ?? []) {
			(listener as (value: unknown) => void)(event);
		}
	}
}

afterEach(() => {
	FakeWebSocket.instances = [];
	vi.unstubAllGlobals();
});

describe("RealtimeClient", () => {
	it("emits structured diagnostics without exposing query contents", async () => {
		useFakeWebSocket();
		const entries: unknown[] = [];
		const client = createRealtimeClient({
			url: "ws://live.test/v1?secret=do-not-log",
			logLevel: "debug",
			logger: (entry) => entries.push(entry),
		});
		const subscription = client.subscribe(query("sensitive-capability"));
		const delivered = vi.fn();
		subscription.onChange(() => {
			throw new Error("listener failed");
		});
		subscription.onChange(delivered);

		const socket = connectAndAdmit();
		baselineSync(socket, "sensitive row value");
		await Promise.resolve();

		expect(
			entries.map((entry) => (entry as { event: string }).event),
		).toEqual(
			expect.arrayContaining([
				"subscription_started",
				"connection_attempt_started",
				"connection_ready",
				"subscription_admitted",
				"subscription_baseline_sync_started",
				"subscription_baseline_sync_completed",
				"subscription_live",
				"subscription_listener_failed",
			]),
		);
		expect(delivered).toHaveBeenCalledOnce();
		const serialized = JSON.stringify(entries);
		expect(serialized).not.toContain("sensitive-capability");
		expect(serialized).not.toContain("sensitive row value");
		expect(serialized).not.toContain("do-not-log");
		client.close();
	});

	it("logs only baseline syncs accepted and installed by reconciliation", async () => {
		useFakeWebSocket();
		const events: string[] = [];
		const client = createRealtimeClient({
			url: "ws://live.test/v1",
			logLevel: "debug",
			logger: (entry) => events.push(entry.event),
			parsers: defineParsers({
				90000: () => {
					throw new Error("row decoding failed");
				},
			}),
		});
		const subscription = client.subscribe(query("initial"));
		const socket = defined(FakeWebSocket.instances[0]);
		socket.open();
		socket.receive({ type: "ready" });
		const request = defined(
			socket.sent.find((message) => message.type === "subscribe"),
		);
		socket.receive({
			type: "subscribed",
			request_id: request.request_id,
			live_id: "41",
			epoch: "1",
			first_sequence: "1",
			columns: [
				{
					name: "value",
					type_oid: 90000,
					typmod: -1,
					codec: "pg_text",
				},
			],
		});
		socket.receive({
			type: "baseline_sync_start",
			live_id: "41",
			epoch: "1",
			baseline_sync_attempt: "2",
			mvcc: { xmin: "1", xmax: "2", xip: [] },
		});
		socket.receive({
			type: "baseline_sync_start",
			live_id: "41",
			epoch: "1",
			baseline_sync_attempt: "1",
			mvcc: { xmin: "1", xmax: "2", xip: [] },
		});
		socket.receive({
			type: "baseline_sync_end",
			live_id: "41",
			epoch: "1",
			baseline_sync_attempt: "1",
			batch_count: 0,
		});
		socket.receive({
			type: "baseline_sync_batch",
			live_id: "41",
			epoch: "1",
			baseline_sync_attempt: "2",
			index: 0,
			rows: [{ row_key: ROW_KEY, values: ["private-value"] }],
		});
		socket.receive({
			type: "baseline_sync_end",
			live_id: "41",
			epoch: "1",
			baseline_sync_attempt: "2",
			batch_count: 1,
		});
		await Promise.resolve();

		expect(
			events.filter(
				(event) => event === "subscription_baseline_sync_started",
			),
		).toHaveLength(1);
		expect(events).toContain("subscription_row_decoding_failed");
		expect(events).not.toContain("subscription_baseline_sync_completed");
		expect(subscription.getSnapshot().status).toBe("error");
		client.close();
	});

	it("logs a reset requirement only after its publication commits", async () => {
		useFakeWebSocket();
		const events: string[] = [];
		const client = createRealtimeClient({
			url: "ws://live.test/v1",
			logLevel: "debug",
			logger: (entry) => events.push(entry.event),
		});
		client.subscribe(query("initial"));
		const socket = connectAndAdmit();
		baselineSync(socket, "before");
		await Promise.resolve();
		events.length = 0;

		socket.receive({ type: "open", publication_id: "reset" });
		socket.receive({
			type: "reset_required",
			publication_id: "reset",
			index: 0,
			targets: [{ live_id: "41", epoch: "2", first_sequence: "1" }],
		});
		await Promise.resolve();
		expect(events).not.toContain("subscription_reset_required");

		socket.receive({
			type: "commit",
			publication_id: "reset",
			body_count: 1,
			frontier: { lsn: "0/10" },
		});
		await Promise.resolve();
		expect(events).toContain("subscription_reset_required");
		client.close();
	});

	it("queues baseline-sync completion before reentrant reset listeners", async () => {
		useFakeWebSocket();
		const events: string[] = [];
		const client = createRealtimeClient({
			url: "ws://live.test/v1",
			logLevel: "debug",
			logger: (entry) => events.push(entry.event),
		});
		const subscription = client.subscribe(query("initial"));
		subscription.onReset(() => subscription.unsubscribe());

		baselineSync(connectAndAdmit(), "value");
		await Promise.resolve();

		expect(events).toEqual(
			expect.arrayContaining([
				"subscription_baseline_sync_completed",
				"subscription_unsubscribed",
			]),
		);
		expect(
			events.indexOf("subscription_baseline_sync_completed"),
		).toBeLessThan(events.indexOf("subscription_unsubscribed"));
		client.close();
	});

	it("queues publication commit before reentrant batch listeners", async () => {
		useFakeWebSocket();
		const events: string[] = [];
		const client = createRealtimeClient({
			url: "ws://live.test/v1",
			logLevel: "debug",
			logger: (entry) => events.push(entry.event),
		});
		const subscription = client.subscribe(query("initial"));
		const socket = connectAndAdmit();
		baselineSync(socket, "before");
		await Promise.resolve();
		events.length = 0;
		subscription.onBatch(() => client.close());

		publication(
			socket,
			[{ op: "upsert", row_key: ROW_KEY, values: ["1", "after"] }],
			["42"],
		);
		await Promise.resolve();

		expect(events).toEqual(
			expect.arrayContaining([
				"connection_publication_committed",
				"client_closed",
			]),
		);
		expect(events.indexOf("connection_publication_committed")).toBeLessThan(
			events.indexOf("client_closed"),
		);
	});

	it("does not let a logger re-enter subscription admission", async () => {
		useFakeWebSocket();
		let subscription!: MaterializedLiveQuerySubscription<MessageRow>;
		const client = createRealtimeClient({
			url: "ws://live.test/v1",
			logLevel: "debug",
			logger: (entry) => {
				if (entry.event === "subscription_admitted") {
					subscription.unsubscribe();
				}
			},
		});
		subscription = client.subscribe(query("initial"));

		const socket = connectAndAdmit();
		expect(subscription.getState().status).toBe("connecting");
		await Promise.resolve();

		expect(subscription.getState().status).toBe("closed");
		expect(socket.sent.at(-1)).toMatchObject({
			type: "unsubscribe",
			live_id: "41",
		});
		client.close();
	});

	it("materializes a baseline sync using the subscribed result schema", () => {
		useFakeWebSocket();
		const client = createRealtimeClient({
			url: "ws://live.test/v1",
		});
		const subscription = client.subscribe(query("initial"));
		expectTypeOf(subscription).toEqualTypeOf<
			MaterializedLiveQuerySubscription<MessageRow>
		>();
		expect(subscription.getSnapshot()).toEqual({
			status: "connecting",
			error: undefined,
			data: undefined,
		});

		const socket = connectAndAdmit();
		baselineSync(socket, "before");

		expect(socket.protocols).toBe("neon.live.v1");
		expect(socket.sent[0]).toMatchObject({ type: "subscribe" });
		expect(subscription.getSnapshot()).toEqual({
			status: "live",
			error: undefined,
			data: [{ id: 1, title: "before" }],
		});
		client.close();
	});

	it("preserves wire order across batches and replacement resets", () => {
		useFakeWebSocket();
		const client = createRealtimeClient({
			url: "ws://live.test/v1",
		});
		const subscription = client.subscribe(query("ordered"));
		const resets: unknown[] = [];
		subscription.onReset((rows) => resets.push(rows));
		const socket = connectAndAdmit();

		baselineSyncRows(socket, [
			[
				{ row_key: ROW_KEY_C, values: ["3", "third"] },
				{ row_key: ROW_KEY, values: ["1", "first"] },
			],
			[{ row_key: ROW_KEY_B, values: ["2", "second"] }],
		]);
		expect(subscription.getSnapshot()).toEqual({
			status: "live",
			error: undefined,
			data: [
				{ id: 3, title: "third" },
				{ id: 1, title: "first" },
				{ id: 2, title: "second" },
			],
		});

		reset(socket, "2");
		expect(subscription.getSnapshot()).toEqual({
			status: "stale",
			error: undefined,
			data: [
				{ id: 3, title: "third" },
				{ id: 1, title: "first" },
				{ id: 2, title: "second" },
			],
		});
		baselineSyncRows(
			socket,
			[
				[{ row_key: ROW_KEY_B, values: ["2", "second replacement"] }],
				[
					{ row_key: ROW_KEY_C, values: ["3", "third replacement"] },
					{ row_key: ROW_KEY, values: ["1", "first replacement"] },
				],
			],
			"41",
			"2",
		);

		expect(subscription.getSnapshot()).toEqual({
			status: "live",
			error: undefined,
			data: [
				{ id: 2, title: "second replacement" },
				{ id: 3, title: "third replacement" },
				{ id: 1, title: "first replacement" },
			],
		});
		expect(resets).toEqual([
			[
				{ rowId: ROW_KEY_C, row: { id: 3, title: "third" } },
				{ rowId: ROW_KEY, row: { id: 1, title: "first" } },
				{ rowId: ROW_KEY_B, row: { id: 2, title: "second" } },
			],
			[
				{
					rowId: ROW_KEY_B,
					row: { id: 2, title: "second replacement" },
				},
				{
					rowId: ROW_KEY_C,
					row: { id: 3, title: "third replacement" },
				},
				{
					rowId: ROW_KEY,
					row: { id: 1, title: "first replacement" },
				},
			],
		]);
		client.close();
	});

	it("starts hydrated data as stale and replaces it atomically", () => {
		useFakeWebSocket();
		const client = createRealtimeClient({
			url: "ws://live.test/v1",
		});
		const subscription = client.subscribe(query("initial"), {
			initialData: [{ id: 1, title: "server" }],
		});
		const changes: unknown[] = [];
		subscription.onChange((value) => changes.push(value));
		expect(subscription.getSnapshot()).toMatchObject({
			status: "stale",
			data: [{ id: 1, title: "server" }],
		});

		const socket = connectAndAdmit();
		baselineSync(socket, "live");

		expect(changes).toHaveLength(1);
		expect(subscription.getSnapshot()).toMatchObject({
			status: "live",
			data: [{ id: 1, title: "live" }],
		});
		client.close();
	});

	it("exposes raw resets and atomic batches with every transaction ID", () => {
		useFakeWebSocket();
		const client = createRealtimeClient({
			url: "ws://live.test/v1",
		});
		const subscription = client.subscribe(query("initial"), {
			materialize: false,
		});
		expectTypeOf(subscription).toEqualTypeOf<
			RawLiveQuerySubscription<MessageRow>
		>();
		expectTypeOf(subscription).not.toHaveProperty("awaitRows");
		const resets: unknown[] = [];
		const batches: unknown[] = [];
		subscription.onReset((rows) => resets.push(rows));
		subscription.onBatch((changes, batch) =>
			batches.push({ changes, batch }),
		);

		const socket = connectAndAdmit();
		baselineSync(socket, "before");
		publication(
			socket,
			[
				{
					op: "upsert",
					row_key: ROW_KEY,
					values: ["1", "after"],
				},
			],
			["42", "43"],
		);

		expect(resets).toEqual([
			[{ rowId: ROW_KEY, row: { id: 1, title: "before" } }],
		]);
		expect(batches).toEqual([
			{
				changes: [
					{
						type: "upsert",
						rowId: ROW_KEY,
						row: { id: 1, title: "after" },
					},
				],
				batch: { txids: ["42", "43"] },
			},
		]);
		client.close();
	});

	it("confirms transactions after applying them and remembers early batches", async () => {
		useFakeWebSocket();
		const client = createRealtimeClient({
			url: "ws://live.test/v1",
		});
		const subscription = client.subscribe(query("initial"));
		const socket = connectAndAdmit();
		baselineSync(socket, "before");

		const confirmation = subscription.awaitTxId("00042").then(() => {
			expect(subscription.getSnapshot()).toMatchObject({
				data: [{ id: 1, title: "after" }],
			});
		});
		publication(
			socket,
			[
				{
					op: "upsert",
					row_key: ROW_KEY,
					values: ["1", "after"],
				},
			],
			["42"],
		);

		await expect(confirmation).resolves.toBeUndefined();
		await expect(subscription.awaitTxId("42")).resolves.toBeUndefined();
		client.close();
	});

	it("confirms transactions visible to an applied MVCC snapshot", async () => {
		useFakeWebSocket();
		const client = createRealtimeClient({
			url: "ws://live.test/v1",
		});
		const subscription = client.subscribe(query("initial"));
		const socket = connectAndAdmit();
		let resolvedBeforeEnd = false;
		const beforeXmin = subscription.awaitTxId("99").then(() => {
			resolvedBeforeEnd = true;
		});
		const atXmin = subscription.awaitTxId("100");
		const inProgress = subscription.awaitTxId("103");
		const atXmax = subscription.awaitTxId("105");

		socket.receive({
			type: "baseline_sync_start",
			live_id: "41",
			epoch: "1",
			baseline_sync_attempt: "1",
			mvcc: { xmin: "100", xmax: "105", xip: ["103"] },
		});
		await Promise.resolve();
		expect(resolvedBeforeEnd).toBe(false);
		socket.receive({
			type: "baseline_sync_end",
			live_id: "41",
			epoch: "1",
			baseline_sync_attempt: "1",
			batch_count: 0,
		});

		await expect(beforeXmin).resolves.toBeUndefined();
		await expect(atXmin).resolves.toBeUndefined();
		await expect(subscription.awaitTxId("104")).resolves.toBeUndefined();
		let inProgressResolved = false;
		let atXmaxResolved = false;
		void inProgress.then(
			() => {
				inProgressResolved = true;
			},
			() => undefined,
		);
		void atXmax.then(
			() => {
				atXmaxResolved = true;
			},
			() => undefined,
		);
		await Promise.resolve();
		expect(inProgressResolved).toBe(false);
		expect(atXmaxResolved).toBe(false);

		subscription.unsubscribe();
		await expect(inProgress).rejects.toThrow("subscription is closed");
		await expect(atXmax).rejects.toThrow("subscription is closed");
		client.close();
	});

	it("confirms a transaction when a later reset snapshot proves it visible", async () => {
		useFakeWebSocket();
		const client = createRealtimeClient({
			url: "ws://live.test/v1",
		});
		const subscription = client.subscribe(query("initial"));
		const socket = connectAndAdmit();
		baselineSync(socket, "before");
		const confirmation = subscription.awaitTxId("42");

		socket.receive({ type: "open", publication_id: "reset" });
		socket.receive({
			type: "reset_required",
			publication_id: "reset",
			index: 0,
			targets: [{ live_id: "41", epoch: "2", first_sequence: "1" }],
		});
		socket.receive({
			type: "commit",
			publication_id: "reset",
			body_count: 1,
			frontier: { lsn: "0/20" },
		});
		socket.receive({
			type: "baseline_sync_start",
			live_id: "41",
			epoch: "2",
			baseline_sync_attempt: "1",
			mvcc: { xmin: "43", xmax: "44", xip: [] },
		});
		socket.receive({
			type: "baseline_sync_end",
			live_id: "41",
			epoch: "2",
			baseline_sync_attempt: "1",
			batch_count: 0,
		});

		await expect(confirmation).resolves.toBeUndefined();
		client.close();
	});

	it("times out transaction waits and rejects them when closed", async () => {
		useFakeWebSocket();
		const client = createRealtimeClient({
			url: "ws://live.test/v1",
		});
		const subscription = client.subscribe(query("initial"));

		await expect(subscription.awaitTxId("9", 1)).rejects.toThrow(
			"Timed out waiting for live-query transaction 9",
		);
		await expect(subscription.awaitTxId("not-a-txid")).rejects.toThrow(
			"decimal string",
		);
		await expect(
			subscription.awaitTxId("18446744073709551616"),
		).rejects.toThrow("exceeds uint64");
		await expect(subscription.awaitTxId("12", -1)).rejects.toThrow(
			"non-negative",
		);
		const pending = subscription.awaitTxId("10");
		subscription.unsubscribe();
		await expect(pending).rejects.toThrow("subscription is closed");
		await expect(subscription.awaitTxId("11")).rejects.toThrow(
			"subscription is closed",
		);
		client.close();
	});

	it("waits for matching materialized rows and handles an existing match", async () => {
		useFakeWebSocket();
		const client = createRealtimeClient({
			url: "ws://live.test/v1",
		});
		const subscription = client.subscribe(query("initial"));
		const socket = connectAndAdmit();
		baselineSync(socket, "before");

		await expect(
			subscription.awaitRows((rows) => rows[0]?.title === "before"),
		).resolves.toBeUndefined();
		const matchingRows = subscription.awaitRows(
			(rows) => rows[0]?.title === "after",
		);
		publication(
			socket,
			[
				{
					op: "upsert",
					row_key: ROW_KEY,
					values: ["1", "after"],
				},
			],
			["42"],
		);

		await expect(matchingRows).resolves.toBeUndefined();
		client.close();
	});

	it("times out row waits and rejects them when closed", async () => {
		useFakeWebSocket();
		const client = createRealtimeClient({
			url: "ws://live.test/v1",
		});
		const subscription = client.subscribe(query("initial"), {
			initialData: [{ id: 1, title: "before" }],
		});

		await expect(subscription.awaitRows(() => false, 1)).rejects.toThrow(
			"Timed out waiting for live-query rows",
		);
		await expect(subscription.awaitRows(() => false, -1)).rejects.toThrow(
			"non-negative",
		);
		const predicateError = new Error("predicate failed");
		await expect(
			subscription.awaitRows(() => {
				throw predicateError;
			}),
		).rejects.toBe(predicateError);
		const pending = subscription.awaitRows(() => false);
		subscription.unsubscribe();
		await expect(pending).rejects.toThrow("subscription is closed");
		client.close();
	});

	it("renews only with a sealed query for the same query", async () => {
		useFakeWebSocket();
		const client = createRealtimeClient({
			url: "ws://live.test/v1",
		});
		const subscription = client.subscribe(query("initial"));
		const socket = connectAndAdmit();
		baselineSync(socket, "before");

		const renewal = subscription.renew(query("replacement"));
		expect(socket.sent.at(-1)).toEqual({
			type: "renew",
			live_id: "41",
			authorization: query("replacement").capability,
		});
		socket.receive({ type: "renewed", live_id: "41" });
		await expect(renewal).resolves.toBeUndefined();
		await expect(
			subscription.renew(query("other", "22".repeat(32))),
		).rejects.toThrow("same query");
		client.close();
	});

	it("reports rejected renewal attempts without warning for superseded ones", async () => {
		useFakeWebSocket();
		vi.useFakeTimers();
		const events: string[] = [];
		const client = createRealtimeClient({
			url: "ws://live.test/v1",
			logLevel: "warn",
			logger: (entry) => events.push(entry.event),
		});
		const subscription = client.subscribe(query("initial"));
		const socket = connectAndAdmit();
		socket.close();

		const superseded = subscription.renew(query("next"));
		const newest = subscription.renew(query("newest"));
		await expect(superseded).rejects.toMatchObject({
			code: "renewal_superseded",
		});
		await vi.runAllTicks();
		expect(events).not.toContain("subscription_renewal_failed");

		await vi.advanceTimersByTimeAsync(1_000);
		const replacementSocket = FakeWebSocket.instances.at(-1);
		expect(replacementSocket).toBeDefined();
		replacementSocket?.open();
		replacementSocket?.receive({ type: "ready" });
		replacementSocket?.receive({
			type: "subscribe_rejected",
			request_id: "2",
			code: "authorization_expired",
			message: "expired",
		});

		await expect(newest).rejects.toMatchObject({
			code: "authorization_expired",
		});
		await vi.runAllTicks();
		expect(events).toContain("subscription_renewal_failed");
		client.close();
	});

	it("recovers the same logical subscription after its capability expires", async () => {
		useFakeWebSocket();
		const client = createRealtimeClient({
			url: "ws://live.test/v1",
		});
		const subscription = client.subscribe(query("initial"));
		const socket = connectAndAdmit();
		const resets: unknown[] = [];
		subscription.onReset((rows) => resets.push(rows));
		baselineSync(socket, "before");
		socket.receive({
			type: "subscription_error",
			live_id: "41",
			code: "authorization_expired",
			message: "expired",
		});
		expect(subscription.getSnapshot()).toEqual({
			status: "stale",
			error: undefined,
			data: [{ id: 1, title: "before" }],
		});

		const renewal = subscription.renew(query("replacement"));
		expect(socket.sent.at(-1)).toEqual({
			type: "subscribe",
			request_id: "2",
			authorization: query("replacement").capability,
		});
		socket.receive({
			type: "subscribed",
			request_id: "2",
			live_id: "42",
			epoch: "2",
			first_sequence: "1",
			columns: [
				{ name: "id", type_oid: 23, typmod: -1, codec: "pg_text" },
				{ name: "title", type_oid: 25, typmod: -1, codec: "pg_text" },
			],
		});
		await expect(renewal).resolves.toBeUndefined();
		expect(subscription.getSnapshot().status).toBe("stale");

		baselineSync(socket, "after", "42", "2");
		expect(subscription.getSnapshot()).toEqual({
			status: "live",
			error: undefined,
			data: [{ id: 1, title: "after" }],
		});
		expect(resets).toEqual([
			[{ rowId: ROW_KEY, row: { id: 1, title: "before" } }],
			[{ rowId: ROW_KEY, row: { id: 1, title: "after" } }],
		]);

		subscription.unsubscribe();
		subscription.unsubscribe();
		expect(subscription.getSnapshot().status).toBe("closed");
		client.close();
	});

	it("maps permanent subscription failures to error", async () => {
		useFakeWebSocket();
		const client = createRealtimeClient({
			url: "ws://live.test/v1",
		});
		const subscription = client.subscribe(query("initial"));
		const socket = connectAndAdmit();
		const matchingRows = subscription.awaitRows(() => false);
		socket.receive({
			type: "subscription_error",
			live_id: "41",
			code: "baseline_sync_failed",
			message: "snapshot failed",
		});
		expect(subscription.getSnapshot()).toMatchObject({
			status: "error",
			error: { code: "baseline_sync_failed", retryable: false },
		});
		await expect(matchingRows).rejects.toMatchObject({
			code: "baseline_sync_failed",
			retryable: false,
		});
		client.close();
	});

	it("contains parser failures to one subscription on a shared connection", () => {
		useFakeWebSocket();
		const original = new Error("application parser failed");
		const client = createRealtimeClient({
			url: "ws://live.test/v1",
			parsers: defineParsers({
				90000: () => {
					throw original;
				},
			}),
		});
		const failed = client.subscribe(query("failed"));
		const surviving = client.subscribe(query("surviving"));
		const socket = FakeWebSocket.instances[0];
		if (!socket) throw new Error("Missing test WebSocket");
		socket.open();
		socket.receive({ type: "ready" });
		const requests = socket.sent.filter(
			(message) => message.type === "subscribe",
		);
		const failedRequest = requests[0];
		const survivingRequest = requests[1];
		if (!failedRequest || !survivingRequest) {
			throw new Error("Missing subscribe request");
		}
		socket.receive({
			type: "subscribed",
			request_id: failedRequest.request_id,
			live_id: "41",
			epoch: "1",
			first_sequence: "1",
			columns: [
				{
					name: "value",
					type_oid: 90000,
					typmod: -1,
					codec: "pg_text",
				},
			],
		});
		socket.receive({
			type: "subscribed",
			request_id: survivingRequest.request_id,
			live_id: "42",
			epoch: "1",
			first_sequence: "1",
			columns: [
				{ name: "value", type_oid: 25, typmod: -1, codec: "pg_text" },
			],
		});
		emptySnapshot(socket, "41");
		emptySnapshot(socket, "42");

		socket.receive({ type: "open", publication_id: "shared" });
		socket.receive({
			type: "keyed_results",
			publication_id: "shared",
			index: 0,
			txids: ["42"],
			targets: [
				{ live_id: "41", epoch: "1", sequence: "1" },
				{ live_id: "42", epoch: "1", sequence: "1" },
			],
			changes: [
				{ op: "upsert", row_key: ROW_KEY, values: ["private-value"] },
			],
		});
		socket.receive({
			type: "commit",
			publication_id: "shared",
			body_count: 1,
			frontier: { lsn: "0/10" },
		});

		expect(failed.getSnapshot()).toMatchObject({
			status: "error",
			data: [],
			error: {
				code: "parser_error",
				retryable: false,
				cause: original,
			},
		});
		expect(failed.getSnapshot().error?.message).toContain("value");
		expect(failed.getSnapshot().error?.message).toContain("90000");
		expect(failed.getSnapshot().error?.message).not.toContain(
			"private-value",
		);
		expect(surviving.getSnapshot()).toEqual({
			status: "live",
			error: undefined,
			data: [{ value: "private-value" }],
		});
		expect(socket.sent).toContainEqual({
			type: "unsubscribe",
			live_id: "41",
		});
		expect(socket.readyState).toBe(1);
		client.close();
	});

	it("does not partially apply a batch when a later value fails to parse", () => {
		useFakeWebSocket();
		const client = createRealtimeClient({
			url: "ws://live.test/v1",
			parsers: defineParsers({
				90000: (value) => {
					if (value === "bad") throw new Error("bad value");
					return value;
				},
			}),
		});
		const subscription = client.subscribe(query("atomic"), {
			initialData: [{ id: 7, title: "retained" }],
		});
		const socket = FakeWebSocket.instances[0];
		if (!socket) throw new Error("Missing test WebSocket");
		socket.open();
		socket.receive({ type: "ready" });
		const request = socket.sent.find(
			(message) => message.type === "subscribe",
		);
		if (!request) throw new Error("Missing subscribe request");
		socket.receive({
			type: "subscribed",
			request_id: request.request_id,
			live_id: "41",
			epoch: "1",
			first_sequence: "1",
			columns: [
				{
					name: "title",
					type_oid: 90000,
					typmod: -1,
					codec: "pg_text",
				},
			],
		});
		emptySnapshot(socket, "41");
		socket.receive({ type: "open", publication_id: "atomic" });
		socket.receive({
			type: "keyed_results",
			publication_id: "atomic",
			index: 0,
			txids: ["44"],
			targets: [{ live_id: "41", epoch: "1", sequence: "1" }],
			changes: [
				{ op: "upsert", row_key: ROW_KEY, values: ["good"] },
				{ op: "upsert", row_key: "b".repeat(64), values: ["bad"] },
			],
		});
		socket.receive({
			type: "commit",
			publication_id: "atomic",
			body_count: 1,
			frontier: { lsn: "0/10" },
		});

		expect(subscription.getSnapshot()).toMatchObject({
			status: "error",
			data: [],
			error: { code: "parser_error" },
		});
		client.close();
	});
});

function useFakeWebSocket(): void {
	vi.stubGlobal("WebSocket", FakeWebSocket);
}

function connectAndAdmit(): FakeWebSocket {
	const socket = defined(FakeWebSocket.instances.at(-1));
	socket.open();
	socket.receive({ type: "ready" });
	const request = defined(
		socket.sent.find((message) => message.type === "subscribe"),
	);
	socket.receive({
		type: "subscribed",
		request_id: request.request_id,
		live_id: "41",
		epoch: "1",
		first_sequence: "1",
		columns: [
			{ name: "id", type_oid: 23, typmod: -1, codec: "pg_text" },
			{ name: "title", type_oid: 25, typmod: -1, codec: "pg_text" },
		],
	});
	return socket;
}

function baselineSync(
	socket: FakeWebSocket,
	title: string,
	liveId = "41",
	epoch = "1",
): void {
	baselineSyncRows(
		socket,
		[[{ row_key: ROW_KEY, values: ["1", title] }]],
		liveId,
		epoch,
	);
}

function baselineSyncRows(
	socket: FakeWebSocket,
	batches: readonly (readonly {
		readonly row_key: string;
		readonly values: readonly (string | null)[];
	}[])[],
	liveId = "41",
	epoch = "1",
): void {
	socket.receive({
		type: "baseline_sync_start",
		live_id: liveId,
		epoch,
		baseline_sync_attempt: "1",
		mvcc: { xmin: "1", xmax: "2", xip: [] },
	});
	for (const [index, rows] of batches.entries()) {
		socket.receive({
			type: "baseline_sync_batch",
			live_id: liveId,
			epoch,
			baseline_sync_attempt: "1",
			index,
			rows,
		});
	}
	socket.receive({
		type: "baseline_sync_end",
		live_id: liveId,
		epoch,
		baseline_sync_attempt: "1",
		batch_count: batches.length,
	});
}

function reset(socket: FakeWebSocket, epoch: string): void {
	socket.receive({ type: "open", publication_id: `reset-${epoch}` });
	socket.receive({
		type: "reset_required",
		publication_id: `reset-${epoch}`,
		index: 0,
		targets: [{ live_id: "41", epoch, first_sequence: "1" }],
	});
	socket.receive({
		type: "commit",
		publication_id: `reset-${epoch}`,
		body_count: 1,
		frontier: { lsn: "0/10" },
	});
}

function emptySnapshot(
	socket: FakeWebSocket,
	liveId: string,
	epoch = "1",
): void {
	socket.receive({
		type: "baseline_sync_start",
		live_id: liveId,
		epoch,
		baseline_sync_attempt: "1",
		mvcc: { xmin: "1", xmax: "2", xip: [] },
	});
	socket.receive({
		type: "baseline_sync_end",
		live_id: liveId,
		epoch,
		baseline_sync_attempt: "1",
		batch_count: 0,
	});
}

function publication(
	socket: FakeWebSocket,
	changes: readonly object[],
	txids: readonly string[],
): void {
	socket.receive({ type: "open", publication_id: "7" });
	socket.receive({
		type: "keyed_results",
		publication_id: "7",
		index: 0,
		txids,
		targets: [{ live_id: "41", epoch: "1", sequence: "1" }],
		changes,
	});
	socket.receive({
		type: "commit",
		publication_id: "7",
		body_count: 1,
		frontier: { lsn: "0/10" },
	});
}

function query(
	capabilityId: string,
	queryFingerprint = QUERY_FINGERPRINT,
): SealedLiveQuery<MessageRow> {
	return {
		capability: compactJwe(capabilityId),
		queryFingerprint,
		expiresAt: Date.now() + 60_000,
	};
}

function compactJwe(payload: string): string {
	const header = Buffer.from(
		JSON.stringify({
			alg: "dir",
			enc: "A256GCM",
			kid: "current",
			v: 1,
		}),
	).toString("base64url");
	return `${header}..a.${Buffer.from(payload).toString("base64url")}.c`;
}
