import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";

import { defined } from "../defined.test-helpers.js";
import type { LiveQueryAuthorization } from "./authorization.js";
import {
	createNeonLiveClient,
	type MaterializedLiveQuerySubscription,
	type RawLiveQuerySubscription,
} from "./neon-live-client.js";

interface MessageRow {
	readonly id: number;
	readonly title: string;
}

const QUERY_FINGERPRINT = "11".repeat(32);
const ROW_KEY = "a".repeat(64);

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
		const subscription = client.subscribe(authorization("initial"));
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

	it("starts hydrated data as stale and replaces it atomically", () => {
		useFakeWebSocket();
		const client = createNeonLiveClient({
			url: "ws://live.test/v1",
		});
		const subscription = client.subscribe(authorization("initial"), {
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
		const subscription = client.subscribe(authorization("initial"), {
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

	it("renews only with an authorization for the same query", async () => {
		useFakeWebSocket();
		const client = createNeonLiveClient({
			url: "ws://live.test/v1",
		});
		const subscription = client.subscribe(authorization("initial"));
		const socket = connectAndAdmit();
		snapshot(socket, "before");

		const renewal = subscription.renew(authorization("replacement"));
		expect(socket.sent.at(-1)).toEqual({
			type: "renew",
			live_id: "41",
			authorization: authorization("replacement").capability,
		});
		socket.receive({ type: "renewed", live_id: "41" });
		await expect(renewal).resolves.toBeUndefined();
		await expect(
			subscription.renew(authorization("other", "22".repeat(32))),
		).rejects.toThrow("same query");
		client.close();
	});

	it("recovers the same logical subscription after its capability expires", async () => {
		useFakeWebSocket();
		const client = createNeonLiveClient({
			url: "ws://live.test/v1",
		});
		const subscription = client.subscribe(authorization("initial"));
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

		const renewal = subscription.renew(authorization("replacement"));
		expect(socket.sent.at(-1)).toEqual({
			type: "subscribe",
			request_id: "2",
			authorization: authorization("replacement").capability,
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
		const subscription = client.subscribe(authorization("initial"));
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
	socket.receive({
		type: "snapshot_start",
		live_id: liveId,
		epoch,
		snapshot_attempt: "1",
		mvcc: { xmin: "1", xmax: "2", xip: [] },
	});
	socket.receive({
		type: "snapshot_chunk",
		live_id: liveId,
		epoch,
		snapshot_attempt: "1",
		index: 0,
		rows: [{ row_key: ROW_KEY, values: ["1", title] }],
	});
	socket.receive({
		type: "snapshot_end",
		live_id: liveId,
		epoch,
		snapshot_attempt: "1",
		chunk_count: 1,
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

function authorization(
	capabilityId: string,
	queryFingerprint = QUERY_FINGERPRINT,
): LiveQueryAuthorization<MessageRow> {
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
