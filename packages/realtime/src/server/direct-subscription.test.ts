import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import type {
	MaterializedLiveQuerySubscription,
	RawLiveQuerySubscription,
} from "../client/types.js";
import { defined } from "../defined.test-helpers.js";
import { createRealtime, type RawSqlQuery, rawSql } from "./realtime.js";

const KEY = Uint8Array.from({ length: 32 }, (_, index) => index);
const SECRET = encodeSecret({
	v: 1,
	kid: "current",
	iss: "example-app",
	key: base64Url(KEY),
});
const ROW_KEY = "a".repeat(64);

interface MessageRow {
	readonly id: number;
	readonly body: string;
}

type FakeWebSocketListener =
	| (() => void)
	| ((event: { readonly data: unknown }) => void);

class FakeWebSocket {
	static instances: FakeWebSocket[] = [];
	readyState = 0;
	readonly sent: Record<string, unknown>[] = [];
	readonly url: string;
	readonly protocols: string | string[];
	private readonly listeners = new Map<string, Set<FakeWebSocketListener>>();

	constructor(url: string, protocols: string | string[]) {
		this.url = url;
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
		const message = JSON.parse(data) as Record<string, unknown>;
		this.sent.push(message);
		if (message.type === "ping") {
			this.receive({ type: "pong", token: message.token });
		}
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
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	FakeWebSocket.instances = [];
});

describe("trusted direct subscriptions", () => {
	it("forwards diagnostics to the hidden client", async () => {
		useFakeWebSocket();
		const events: string[] = [];
		const realtime = createRealtime({
			secret: SECRET,
			db: "app",
			url: "ws://live.test/v1",
			logLevel: "info",
			logger: (entry) => events.push(entry.event),
		});

		await realtime.subscribe(messagesByOwner("alice"));
		const socket = connectAndAdmit();
		baselineSync(socket, "hello");

		expect(events).toEqual(
			expect.arrayContaining(["connection_ready", "subscription_live"]),
		);
		realtime.close();
	});

	it("returns the existing materialized subscription API", async () => {
		useFakeWebSocket();
		const realtime = createRealtime({
			secret: SECRET,
			db: "app",
			url: "ws://live.test/v1",
		});

		const subscription = await realtime.subscribe(messagesByOwner("alice"));

		expectTypeOf(subscription).toEqualTypeOf<
			MaterializedLiveQuerySubscription<MessageRow>
		>();
		expect(subscription.getSnapshot()).toEqual({
			status: "connecting",
			error: undefined,
			data: undefined,
		});
		const socket = connectAndAdmit();
		baselineSync(socket, "hello");
		expect(socket.url).toBe("ws://live.test/v1");
		expect(socket.protocols).toBe("neon.live.v1");
		expect(subscription.getSnapshot()).toMatchObject({
			status: "live",
			data: [{ id: 1, body: "hello" }],
		});
		await expect(
			subscription.awaitRows((rows) => rows[0]?.body === "hello"),
		).resolves.toBeUndefined();

		subscription.unsubscribe();
		expect(subscription.getState().status).toBe("closed");
		realtime.close();
	});

	it("supports raw subscriptions and closes the shared client", async () => {
		useFakeWebSocket();
		const realtime = createRealtime({
			secret: SECRET,
			db: "app",
			url: "ws://live.test/v1",
		});
		const materialized = await realtime.subscribe(messagesByOwner("alice"));
		const raw = await realtime.subscribe(messagesByOwner("bob"), {
			materialize: false,
		});

		expectTypeOf(raw).toEqualTypeOf<RawLiveQuerySubscription<MessageRow>>();
		expect(FakeWebSocket.instances).toHaveLength(1);
		realtime.close();
		realtime.close();

		expect(materialized.getState().status).toBe("closed");
		expect(raw.getState().status).toBe("closed");
		await expect(
			realtime.subscribe(messagesByOwner("carol")),
		).rejects.toThrow("direct client is closed");
	});

	it("refreshes the same prepared query and stops after unsubscribe", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		useFakeWebSocket();
		interface AdapterQuery {
			readonly owner: string;
		}
		const prepare = vi.fn((query: AdapterQuery) =>
			messagesByOwner(query.owner),
		);
		const realtime = createRealtime<AdapterQuery>({
			secret: SECRET,
			db: "app",
			url: "ws://live.test/v1",
			adapter: { prepare },
		});
		const subscription = await realtime.subscribe({ owner: "alice" });
		const socket = connectAndAdmit();
		const initialCapability = defined(
			socket.sent.find((message) => message.type === "subscribe"),
		).authorization;

		await vi.advanceTimersByTimeAsync(50_000);
		await flushWebCrypto();
		const renewal = socket.sent.find((message) => message.type === "renew");
		expect(renewal).toMatchObject({ type: "renew", live_id: "41" });
		expect(defined(renewal).authorization).not.toBe(initialCapability);
		socket.receive({ type: "renewed", live_id: "41" });
		await Promise.resolve();
		expect(prepare).toHaveBeenCalledOnce();

		subscription.unsubscribe();
		const renewals = socket.sent.filter(
			(message) => message.type === "renew",
		);
		await vi.advanceTimersByTimeAsync(120_000);
		expect(
			socket.sent.filter((message) => message.type === "renew"),
		).toHaveLength(renewals.length);
		realtime.close();
	});

	it("recovers one logical subscription after an outage spanning multiple capabilities", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		useFakeWebSocket();
		const realtime = createRealtime({
			secret: SECRET,
			db: "app",
			url: "ws://live.test/v1",
		});
		const subscription = await realtime.subscribe(messagesByOwner("alice"));
		const first = connectAndAdmit();
		const initialCapability = defined(
			first.sent.find((message) => message.type === "subscribe"),
		).authorization;
		baselineSync(first, "before");

		first.close();
		expect(subscription.getSnapshot()).toEqual({
			status: "stale",
			error: undefined,
			data: [{ id: 1, body: "before" }],
		});
		await vi.advanceTimersByTimeAsync(1_000);
		const recovered = defined(FakeWebSocket.instances.at(-1));

		for (let refresh = 0; refresh < 4; refresh += 1) {
			await vi.advanceTimersByTimeAsync(50_000);
			await flushWebCrypto();
		}
		expect(subscription.getState().status).toBe("stale");

		recovered.open();
		recovered.receive({ type: "ready" });
		const request = defined(
			recovered.sent.find((message) => message.type === "subscribe"),
		);
		expect(request.authorization).not.toBe(initialCapability);
		admitRequest(recovered, request, "42", "2");
		baselineSync(recovered, "after", "42", "2");

		expect(subscription.getSnapshot()).toEqual({
			status: "live",
			error: undefined,
			data: [{ id: 1, body: "after" }],
		});
		subscription.unsubscribe();
		realtime.close();
	});

	it("keeps sealing-only instances free of direct client methods", () => {
		const realtime = createRealtime({ secret: SECRET, db: "app" });

		expect("subscribe" in realtime).toBe(false);
		expect("close" in realtime).toBe(false);
		expectTypeOf(realtime).not.toHaveProperty("subscribe");
		expectTypeOf(realtime).not.toHaveProperty("close");
	});

	it("requires a WebSocket URL when direct subscriptions are enabled", () => {
		expect(() =>
			createRealtime({ secret: SECRET, db: "app", url: "" }),
		).toThrow("requires a WebSocket URL");
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
	admitRequest(socket, request, "41", "1");
	return socket;
}

function admitRequest(
	socket: FakeWebSocket,
	request: Record<string, unknown>,
	liveId: string,
	epoch: string,
): void {
	socket.receive({
		type: "subscribed",
		request_id: request.request_id,
		live_id: liveId,
		epoch,
		first_sequence: "1",
		columns: [
			{ name: "id", type_oid: 23, typmod: -1, codec: "pg_text" },
			{ name: "body", type_oid: 25, typmod: -1, codec: "pg_text" },
		],
	});
}

function baselineSync(
	socket: FakeWebSocket,
	body: string,
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
	socket.receive({
		type: "baseline_sync_batch",
		live_id: liveId,
		epoch,
		baseline_sync_attempt: "1",
		index: 0,
		rows: [{ row_key: ROW_KEY, values: ["1", body] }],
	});
	socket.receive({
		type: "baseline_sync_end",
		live_id: liveId,
		epoch,
		baseline_sync_attempt: "1",
		batch_count: 1,
	});
}

function messagesByOwner(owner: string): RawSqlQuery<MessageRow> {
	return rawSql<MessageRow>(
		"select id, body from messages where owner = $1",
		[owner],
	);
}

function encodeSecret(value: object): string {
	return `neon_live_v1_${base64Url(new TextEncoder().encode(JSON.stringify(value)))}`;
}

function base64Url(value: Uint8Array): string {
	let binary = "";
	for (const byte of value) binary += String.fromCharCode(byte);
	return btoa(binary)
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
}

async function flushWebCrypto(): Promise<void> {
	// Capability refresh performs one digest and one encryption before sending
	// the renewal frame; Web Crypto completes outside Vitest's fake timer queue.
	await crypto.subtle.digest("SHA-256", new Uint8Array());
	await crypto.subtle.digest("SHA-256", new Uint8Array());
	await Promise.resolve();
}
