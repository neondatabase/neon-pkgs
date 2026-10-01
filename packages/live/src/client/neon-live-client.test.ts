import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";

import { defined } from "../defined.test-helpers.js";
import {
	createNeonLiveClient,
	type MaterializedLiveQuerySubscription,
	type RawLiveQuerySubscription,
} from "./neon-live-client.js";
import { defineParsers } from "./postgres/parsers.js";
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

describe("NeonLiveClient", () => {
	it("materializes a v1 snapshot using the subscribed result schema", () => {
		useFakeWebSocket();
		const client = createNeonLiveClient({
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
		snapshot(socket, "before");

		expect(socket.protocols).toBe("neon.live.v1");
		expect(socket.sent[0]).toMatchObject({ type: "subscribe" });
		expect(subscription.getSnapshot()).toEqual({
			status: "live",
			error: undefined,
			data: [{ id: 1, title: "before" }],
		});
		client.close();
	});

	it("preserves wire order across chunks and replacement resets", () => {
		useFakeWebSocket();
		const client = createNeonLiveClient({
			url: "ws://live.test/v1",
		});
		const subscription = client.subscribe(query("ordered"));
		const resets: unknown[] = [];
		subscription.onReset((rows) => resets.push(rows));
		const socket = connectAndAdmit();

		snapshotRows(socket, [
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
		snapshotRows(
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
		const client = createNeonLiveClient({
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
		snapshot(socket, "live");

		expect(changes).toHaveLength(1);
		expect(subscription.getSnapshot()).toMatchObject({
			status: "live",
			data: [{ id: 1, title: "live" }],
		});
		client.close();
	});

	it("exposes raw resets and atomic batches with every transaction ID", () => {
		useFakeWebSocket();
		const client = createNeonLiveClient({
			url: "ws://live.test/v1",
		});
		const subscription = client.subscribe(query("initial"), {
			materialize: false,
		});
		expectTypeOf(subscription).toEqualTypeOf<
			RawLiveQuerySubscription<MessageRow>
		>();
		const resets: unknown[] = [];
		const batches: unknown[] = [];
		subscription.onReset((rows) => resets.push(rows));
		subscription.onBatch((changes, batch) =>
			batches.push({ changes, batch }),
		);

		const socket = connectAndAdmit();
		snapshot(socket, "before");
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
		const client = createNeonLiveClient({
			url: "ws://live.test/v1",
		});
		const subscription = client.subscribe(query("initial"));
		const socket = connectAndAdmit();
		snapshot(socket, "before");

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
		const client = createNeonLiveClient({
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
			type: "snapshot_start",
			live_id: "41",
			epoch: "1",
			snapshot_attempt: "1",
			mvcc: { xmin: "100", xmax: "105", xip: ["103"] },
		});
		await Promise.resolve();
		expect(resolvedBeforeEnd).toBe(false);
		socket.receive({
			type: "snapshot_end",
			live_id: "41",
			epoch: "1",
			snapshot_attempt: "1",
			chunk_count: 0,
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
		const client = createNeonLiveClient({
			url: "ws://live.test/v1",
		});
		const subscription = client.subscribe(query("initial"));
		const socket = connectAndAdmit();
		snapshot(socket, "before");
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
			type: "snapshot_start",
			live_id: "41",
			epoch: "2",
			snapshot_attempt: "1",
			mvcc: { xmin: "43", xmax: "44", xip: [] },
		});
		socket.receive({
			type: "snapshot_end",
			live_id: "41",
			epoch: "2",
			snapshot_attempt: "1",
			chunk_count: 0,
		});

		await expect(confirmation).resolves.toBeUndefined();
		client.close();
	});

	it("times out transaction waits and rejects them when closed", async () => {
		useFakeWebSocket();
		const client = createNeonLiveClient({
			url: "ws://live.test/v1",
		});
		const subscription = client.subscribe(query("initial"));

		await expect(subscription.awaitTxId("9", 1)).rejects.toThrow(
			"Timed out waiting for Neon Live transaction 9",
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

	it("renews only with a sealed query for the same query", async () => {
		useFakeWebSocket();
		const client = createNeonLiveClient({
			url: "ws://live.test/v1",
		});
		const subscription = client.subscribe(query("initial"));
		const socket = connectAndAdmit();
		snapshot(socket, "before");

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

	it("recovers the same logical subscription after its capability expires", async () => {
		useFakeWebSocket();
		const client = createNeonLiveClient({
			url: "ws://live.test/v1",
		});
		const subscription = client.subscribe(query("initial"));
		const socket = connectAndAdmit();
		const resets: unknown[] = [];
		subscription.onReset((rows) => resets.push(rows));
		snapshot(socket, "before");
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

		snapshot(socket, "after", "42", "2");
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

	it("maps permanent subscription failures to error", () => {
		useFakeWebSocket();
		const client = createNeonLiveClient({
			url: "ws://live.test/v1",
		});
		const subscription = client.subscribe(query("initial"));
		const socket = connectAndAdmit();
		socket.receive({
			type: "subscription_error",
			live_id: "41",
			code: "snapshot_failed",
			message: "snapshot failed",
		});
		expect(subscription.getSnapshot()).toMatchObject({
			status: "error",
			error: { code: "snapshot_failed", retryable: false },
		});
		client.close();
	});

	it("contains parser failures to one subscription on a shared connection", () => {
		useFakeWebSocket();
		const original = new Error("application parser failed");
		const client = createNeonLiveClient({
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
		const client = createNeonLiveClient({
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

function snapshot(
	socket: FakeWebSocket,
	title: string,
	liveId = "41",
	epoch = "1",
): void {
	snapshotRows(
		socket,
		[[{ row_key: ROW_KEY, values: ["1", title] }]],
		liveId,
		epoch,
	);
}

function snapshotRows(
	socket: FakeWebSocket,
	chunks: readonly (readonly {
		readonly row_key: string;
		readonly values: readonly (string | null)[];
	}[])[],
	liveId = "41",
	epoch = "1",
): void {
	socket.receive({
		type: "snapshot_start",
		live_id: liveId,
		epoch,
		snapshot_attempt: "1",
		mvcc: { xmin: "1", xmax: "2", xip: [] },
	});
	for (const [index, rows] of chunks.entries()) {
		socket.receive({
			type: "snapshot_chunk",
			live_id: liveId,
			epoch,
			snapshot_attempt: "1",
			index,
			rows,
		});
	}
	socket.receive({
		type: "snapshot_end",
		live_id: liveId,
		epoch,
		snapshot_attempt: "1",
		chunk_count: chunks.length,
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
		type: "snapshot_start",
		live_id: liveId,
		epoch,
		snapshot_attempt: "1",
		mvcc: { xmin: "1", xmax: "2", xip: [] },
	});
	socket.receive({
		type: "snapshot_end",
		live_id: liveId,
		epoch,
		snapshot_attempt: "1",
		chunk_count: 0,
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
