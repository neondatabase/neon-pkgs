import { afterEach, describe, expect, it, vi } from "vitest";

import { defined } from "../../defined.test-helpers.js";
import { createClientEventSink } from "../diagnostics.js";
import type { ReconciliationTarget } from "../reconciliation/reconciler.js";
import {
	type ConnectionCallbacks,
	ConnectionCoordinator,
	type ConnectionCoordinatorOptions,
	type WebSocketLike,
} from "./coordinator.js";

type FakeWebSocketListener =
	| (() => void)
	| ((event: { readonly data: unknown }) => void);

class FakeWebSocket implements WebSocketLike {
	static instances: FakeWebSocket[] = [];
	readyState = 0;
	readonly sent: Record<string, unknown>[] = [];
	readonly protocols: string | string[];
	onSend?: (message: Record<string, unknown>) => void;
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
		const message = JSON.parse(data) as Record<string, unknown>;
		this.sent.push(message);
		this.onSend?.(message);
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

	receive(value: object): void {
		this.emit("message", { data: JSON.stringify(value) });
	}

	disconnect(): void {
		this.readyState = 3;
		this.emit("close", {});
	}

	private emit(type: string, event: unknown): void {
		for (const listener of this.listeners.get(type) ?? []) {
			(listener as (value: unknown) => void)(event);
		}
	}
}

afterEach(() => {
	FakeWebSocket.instances = [];
	vi.useRealTimers();
});

describe("ConnectionCoordinator", () => {
	it("logs connection recovery once per multiplexed connection", async () => {
		vi.useFakeTimers();
		const entries: Array<{ event: string; subscriptionId?: string }> = [];
		const coordinator = createCoordinator({
			events: createClientEventSink({
				logLevel: "debug",
				logger: (entry) => entries.push(entry),
			}),
		});
		coordinator.subscribe({ capability: "one" }, target());
		coordinator.subscribe({ capability: "two" }, target());
		const first = admit();

		first.disconnect();
		await vi.runAllTicks();
		expect(
			entries.filter((entry) => entry.event === "connection_lost"),
		).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(1);
		const second = defined(FakeWebSocket.instances[1]);
		second.open();
		second.receive({ type: "ready" });
		await vi.runAllTicks();

		expect(
			entries.filter((entry) => entry.event === "connection_recovered"),
		).toHaveLength(1);
		expect(entries).toContainEqual(
			expect.objectContaining({
				event: "connection_reconnect_scheduled",
			}),
		);
	});

	it("distinguishes query expiry from encryption-key retirement", async () => {
		const entries: Array<{ event: string }> = [];
		const coordinator = createCoordinator({
			events: createClientEventSink({
				logLevel: "warn",
				logger: (entry) => entries.push(entry),
			}),
		});
		coordinator.subscribe({ capability: "one" }, target());
		const first = admit();
		first.receive({
			type: "subscription_error",
			live_id: "41",
			code: "authorization_expired",
			message: "expired",
		});

		coordinator.subscribe({ capability: "two" }, target());
		const request = defined(
			first.sent.find(
				(message) =>
					message.type === "subscribe" && message.request_id === "2",
			),
		);
		first.receive({
			type: "subscribed",
			request_id: request.request_id,
			live_id: "42",
			epoch: "1",
			first_sequence: "1",
			columns: [],
		});
		first.receive({
			type: "subscription_error",
			live_id: "42",
			code: "key_retired",
			message: "retired",
		});
		await Promise.resolve();

		expect(entries.map((entry) => entry.event)).toEqual([
			"query_expired",
			"query_encryption_key_rotated",
		]);
	});

	it("negotiates neon.live.v1, waits for ready, and routes admission", () => {
		const callbacks = target();
		const coordinator = createCoordinator();
		coordinator.subscribe({ capability: "token" }, callbacks);
		const socket = defined(FakeWebSocket.instances[0]);
		expect(socket.protocols).toBe("neon.live.v1");
		socket.open();
		expect(socket.sent).toEqual([]);
		socket.receive({ type: "ready" });
		expect(socket.sent[0]).toEqual({
			type: "subscribe",
			request_id: "1",
			authorization: "token",
		});
		socket.receive({
			type: "subscribed",
			request_id: "1",
			live_id: "41",
			epoch: "1",
			first_sequence: "1",
			columns: [
				{ name: "id", type_oid: 23, typmod: -1, codec: "pg_text" },
			],
		});
		expect(callbacks.admitted).toHaveBeenCalledWith([
			{ name: "id", type_oid: 23, typmod: -1, codec: "pg_text" },
		]);
	});

	it("serializes overlapping renewals so the newest capability wins", async () => {
		const coordinator = createCoordinator();
		const handle = coordinator.subscribe(
			{ capability: "initial" },
			target(),
		);
		const socket = admit();
		const first = handle.renew({ capability: "next" });
		const second = handle.renew({ capability: "newest" });
		expect(socket.sent.at(-1)).toEqual({
			type: "renew",
			live_id: "41",
			authorization: "next",
		});
		socket.receive({ type: "renewed", live_id: "41" });
		await first;
		expect(socket.sent.at(-1)).toEqual({
			type: "renew",
			live_id: "41",
			authorization: "newest",
		});
		socket.receive({ type: "renewed", live_id: "41" });
		await second;
	});

	it("reconnects and resubscribes with the newest sealed query", async () => {
		vi.useFakeTimers();
		const callbacks = target();
		const events: string[] = [];
		const coordinator = createCoordinator({
			events: createClientEventSink({
				logLevel: "debug",
				logger: (entry) => events.push(entry.event),
			}),
		});
		const handle = coordinator.subscribe(
			{ capability: "initial" },
			callbacks,
		);
		const first = admit();
		const renewal = handle.renew({ capability: "newest" });
		first.disconnect();
		expect(callbacks.disconnected).toHaveBeenCalledOnce();
		await vi.advanceTimersByTimeAsync(1);
		const second = defined(FakeWebSocket.instances[1]);
		second.open();
		second.receive({ type: "ready" });
		expect(second.sent.at(-1)).toEqual({
			type: "subscribe",
			request_id: "2",
			authorization: "newest",
		});
		second.receive({
			type: "subscribed",
			request_id: "2",
			live_id: "42",
			epoch: "1",
			first_sequence: "1",
			columns: [],
		});
		await renewal;
		await vi.runAllTicks();
		expect(
			second.sent.filter((message) => message.type === "renew"),
		).toEqual([]);
		expect(events.filter((event) => event.includes("renew"))).toEqual([
			"subscription_renewal_started",
			"subscription_renewed",
		]);
	});

	it("coalesces queued renewals while disconnected", async () => {
		vi.useFakeTimers();
		const coordinator = createCoordinator();
		const handle = coordinator.subscribe(
			{ capability: "initial" },
			target(),
		);
		admit().disconnect();

		const superseded = handle.renew({ capability: "next" });
		const supersededResult =
			expect(superseded).rejects.toThrow("superseded");
		const newest = handle.renew({ capability: "newest" });
		await supersededResult;
		await vi.advanceTimersByTimeAsync(1);
		const socket = defined(FakeWebSocket.instances[1]);
		socket.open();
		socket.receive({ type: "ready" });
		expect(socket.sent.at(-1)).toEqual({
			type: "subscribe",
			request_id: "2",
			authorization: "newest",
		});
		socket.receive({
			type: "subscribed",
			request_id: "2",
			live_id: "42",
			epoch: "1",
			first_sequence: "1",
			columns: [],
		});
		await expect(newest).resolves.toBeUndefined();
	});

	it("contains a subscription rejection and keeps other subscriptions usable", () => {
		const rejected = target();
		const accepted = target();
		const coordinator = createCoordinator();
		coordinator.subscribe({ capability: "bad" }, rejected);
		coordinator.subscribe({ capability: "good" }, accepted);
		const socket = defined(FakeWebSocket.instances[0]);
		socket.open();
		socket.receive({ type: "ready" });
		socket.receive({
			type: "subscribe_rejected",
			request_id: "1",
			code: "authorization_failed",
			message: "invalid",
		});
		socket.receive({
			type: "subscribed",
			request_id: "2",
			live_id: "42",
			epoch: "1",
			first_sequence: "1",
			columns: [],
		});
		expect(rejected.failed).toHaveBeenCalledWith(
			expect.objectContaining({
				code: "authorization_failed",
				retryable: false,
			}),
		);
		expect(accepted.admitted).toHaveBeenCalledOnce();
	});

	it("suspends an expired subscription until it receives a replacement", async () => {
		const callbacks = target();
		const coordinator = createCoordinator();
		const handle = coordinator.subscribe(
			{ capability: "expired" },
			callbacks,
		);
		const socket = defined(FakeWebSocket.instances[0]);
		socket.open();
		socket.receive({ type: "ready" });
		socket.receive({
			type: "subscribe_rejected",
			request_id: "1",
			code: "authorization_expired",
			message: "expired",
		});
		expect(callbacks.disconnected).toHaveBeenCalledOnce();
		expect(callbacks.failed).not.toHaveBeenCalled();

		const renewal = handle.renew({ capability: "replacement" });
		expect(socket.sent.at(-1)).toEqual({
			type: "subscribe",
			request_id: "2",
			authorization: "replacement",
		});
		socket.receive({
			type: "subscribed",
			request_id: "2",
			live_id: "42",
			epoch: "1",
			first_sequence: "1",
			columns: [],
		});

		await expect(renewal).resolves.toBeUndefined();
		expect(callbacks.admitted).toHaveBeenCalledOnce();
	});

	it("resubscribes with a queued replacement when the active capability expires", async () => {
		const callbacks = target();
		const events: string[] = [];
		const coordinator = createCoordinator({
			events: createClientEventSink({
				logLevel: "debug",
				logger: (entry) => events.push(entry.event),
			}),
		});
		const handle = coordinator.subscribe(
			{ capability: "initial" },
			callbacks,
		);
		const socket = admit();

		const renewal = handle.renew({ capability: "replacement" });
		expect(socket.sent.at(-1)).toEqual({
			type: "renew",
			live_id: "41",
			authorization: "replacement",
		});
		socket.receive({
			type: "subscription_error",
			live_id: "41",
			code: "authorization_expired",
			message: "expired",
		});

		expect(callbacks.disconnected).toHaveBeenCalledOnce();
		expect(socket.sent.at(-1)).toEqual({
			type: "subscribe",
			request_id: "2",
			authorization: "replacement",
		});
		socket.receive({
			type: "subscribed",
			request_id: "2",
			live_id: "42",
			epoch: "1",
			first_sequence: "1",
			columns: [],
		});

		await expect(renewal).resolves.toBeUndefined();
		await Promise.resolve();
		expect(callbacks.failed).not.toHaveBeenCalled();
		expect(events.filter((event) => event.includes("renew"))).toEqual([
			"subscription_renewal_started",
			"subscription_renewed",
		]);
	});

	it("waits for a newer replacement when a replacement has also expired", async () => {
		const callbacks = target();
		const coordinator = createCoordinator();
		const handle = coordinator.subscribe(
			{ capability: "initial" },
			callbacks,
		);
		const socket = defined(FakeWebSocket.instances[0]);
		socket.open();
		socket.receive({ type: "ready" });
		socket.receive({
			type: "subscribe_rejected",
			request_id: "1",
			code: "authorization_expired",
			message: "expired",
		});

		const expiredRenewal = handle.renew({ capability: "also-expired" });
		socket.receive({
			type: "subscribe_rejected",
			request_id: "2",
			code: "authorization_expired",
			message: "expired again",
		});
		await expect(expiredRenewal).rejects.toMatchObject({
			code: "authorization_expired",
		});
		expect(socket.sent).toHaveLength(2);

		const freshRenewal = handle.renew({ capability: "fresh" });
		expect(socket.sent.at(-1)).toEqual({
			type: "subscribe",
			request_id: "3",
			authorization: "fresh",
		});
		socket.receive({
			type: "subscribed",
			request_id: "3",
			live_id: "42",
			epoch: "1",
			first_sequence: "1",
			columns: [],
		});
		await expect(freshRenewal).resolves.toBeUndefined();
	});

	it("reports one connection incident for a malformed message", async () => {
		const firstCallbacks = target();
		const secondCallbacks = target();
		const events: string[] = [];
		const coordinator = createCoordinator({
			events: createClientEventSink({
				logLevel: "error",
				logger: (entry) => events.push(entry.event),
			}),
		});
		coordinator.subscribe({ capability: "one" }, firstCallbacks);
		coordinator.subscribe({ capability: "two" }, secondCallbacks);
		const socket = defined(FakeWebSocket.instances[0]);
		socket.open();
		socket.receive({ type: "ready", unexpected: true });
		for (const callbacks of [firstCallbacks, secondCallbacks]) {
			expect(callbacks.failed).toHaveBeenCalledWith(
				expect.objectContaining({
					code: "protocol_error",
				}),
			);
		}
		await Promise.resolve();
		expect(events).toEqual(["connection_failed"]);
	});

	it("probes an idle ready connection and times it out without inbound activity", async () => {
		vi.useFakeTimers();
		const callbacks = target();
		const coordinator = createCoordinator({
			heartbeat: { idleMs: 20, timeoutMs: 10 },
		});
		coordinator.subscribe({ capability: "token" }, callbacks);
		const socket = admit();

		await vi.advanceTimersByTimeAsync(19);
		expect(
			socket.sent.filter((message) => message.type === "ping"),
		).toEqual([]);
		socket.receive({ type: "pong", token: "server-activity" });
		await vi.advanceTimersByTimeAsync(19);
		expect(
			socket.sent.filter((message) => message.type === "ping"),
		).toEqual([]);
		await vi.advanceTimersByTimeAsync(1);
		expect(socket.sent.at(-1)).toEqual({ type: "ping", token: "c1" });

		await vi.advanceTimersByTimeAsync(10);
		expect(callbacks.disconnected).toHaveBeenCalledOnce();
	});

	it("handles an inbound response delivered synchronously from ping", async () => {
		vi.useFakeTimers();
		const coordinator = createCoordinator({
			heartbeat: { idleMs: 20, timeoutMs: 10 },
		});
		coordinator.subscribe({ capability: "token" }, target());
		const socket = defined(FakeWebSocket.instances[0]);
		socket.onSend = (message) => {
			if (message.type === "ping") {
				socket.receive({ type: "pong", token: message.token });
			}
		};
		socket.open();
		socket.receive({ type: "ready" });

		await vi.advanceTimersByTimeAsync(39);
		expect(
			socket.sent.filter((message) => message.type === "ping"),
		).toHaveLength(1);
		expect(socket.readyState).toBe(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(
			socket.sent.filter((message) => message.type === "ping"),
		).toHaveLength(2);
		expect(socket.readyState).toBe(1);
	});

	it("keeps increasing backoff until a reconnected socket is stable", async () => {
		vi.useFakeTimers();
		const coordinator = createCoordinator({
			reconnect: {
				baseMs: 100,
				capMs: 1_000,
				stabilityMs: 1_000,
				maxElapsedMs: 10_000,
				random: () => 0,
			},
		});
		coordinator.subscribe({ capability: "token" }, target());
		const first = admit();

		first.disconnect();
		await vi.advanceTimersByTimeAsync(49);
		expect(FakeWebSocket.instances).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(1);
		const second = defined(FakeWebSocket.instances[1]);
		second.open();
		second.receive({ type: "ready" });

		await vi.advanceTimersByTimeAsync(999);
		second.disconnect();
		await vi.advanceTimersByTimeAsync(99);
		expect(FakeWebSocket.instances).toHaveLength(2);
		await vi.advanceTimersByTimeAsync(1);
		const third = defined(FakeWebSocket.instances[2]);
		third.open();
		third.receive({ type: "ready" });

		await vi.advanceTimersByTimeAsync(1_000);
		third.disconnect();
		await vi.advanceTimersByTimeAsync(49);
		expect(FakeWebSocket.instances).toHaveLength(3);
		await vi.advanceTimersByTimeAsync(1);
		expect(FakeWebSocket.instances).toHaveLength(4);
	});

	it("fails subscriptions after the reconnect attempt bound", async () => {
		vi.useFakeTimers();
		const callbacks = target();
		const coordinator = createCoordinator({
			reconnect: {
				baseMs: 2,
				capMs: 2,
				stabilityMs: 1_000,
				maxAttempts: 2,
				maxElapsedMs: 10_000,
				random: () => 0,
			},
		});
		coordinator.subscribe({ capability: "token" }, callbacks);
		admit().disconnect();

		await vi.advanceTimersByTimeAsync(1);
		const second = defined(FakeWebSocket.instances[1]);
		second.open();
		second.receive({ type: "ready" });
		second.disconnect();
		await vi.advanceTimersByTimeAsync(1);
		const third = defined(FakeWebSocket.instances[2]);
		third.open();
		third.receive({ type: "ready" });
		third.disconnect();

		expect(callbacks.failed).toHaveBeenCalledWith(
			expect.objectContaining({
				code: "connection_lost",
				retryable: false,
			}),
		);
	});

	it("enforces the reconnect episode elapsed-time bound", async () => {
		vi.useFakeTimers();
		const callbacks = target();
		const coordinator = createCoordinator({
			reconnect: {
				baseMs: 100,
				capMs: 100,
				stabilityMs: 1_000,
				maxAttempts: 20,
				maxElapsedMs: 80,
				random: () => 0,
			},
		});
		coordinator.subscribe({ capability: "token" }, callbacks);
		admit().disconnect();

		await vi.advanceTimersByTimeAsync(50);
		expect(FakeWebSocket.instances).toHaveLength(2);
		await vi.advanceTimersByTimeAsync(30);
		expect(callbacks.failed).toHaveBeenCalledWith(
			expect.objectContaining({
				code: "connection_lost",
			}),
		);
	});

	it("bounds reconnects when the socket factory throws", async () => {
		vi.useFakeTimers();
		const callbacks = target();
		let factoryCalls = 0;
		const coordinator = createCoordinator({
			webSocketFactory: (url, protocols) => {
				factoryCalls += 1;
				if (factoryCalls > 1) throw new Error("socket unavailable");
				return new FakeWebSocket(url, protocols);
			},
			reconnect: {
				baseMs: 2,
				capMs: 2,
				stabilityMs: 1_000,
				maxAttempts: 2,
				maxElapsedMs: 10_000,
				random: () => 0,
			},
		});
		coordinator.subscribe({ capability: "token" }, callbacks);
		admit().disconnect();

		await vi.advanceTimersByTimeAsync(2);
		expect(factoryCalls).toBe(3);
		expect(callbacks.failed).toHaveBeenCalledWith(
			expect.objectContaining({
				code: "connection_lost",
			}),
		);
	});
});

function createCoordinator(
	options: Partial<ConnectionCoordinatorOptions> = {},
): ConnectionCoordinator {
	return new ConnectionCoordinator({
		url: "ws://live.test/v1",
		webSocketFactory: (url, protocols) => new FakeWebSocket(url, protocols),
		reconnect: {
			baseMs: 1,
			capMs: 1,
			stabilityMs: 30,
			maxElapsedMs: 1_000,
			random: () => 0,
		},
		heartbeat: false,
		...options,
	});
}

function admit(): FakeWebSocket {
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
		columns: [],
	});
	return socket;
}

function target(): ConnectionCallbacks & {
	admitted: ReturnType<typeof vi.fn>;
	disconnected: ReturnType<typeof vi.fn>;
	failed: ReturnType<typeof vi.fn>;
} {
	const reconciliation: ReconciliationTarget = {
		baselineSyncStarted: vi.fn(),
		installReset: vi.fn(),
		applyBatch: vi.fn(),
		installContinuity: vi.fn(),
		advanceContinuity: vi.fn(),
		publishReset: vi.fn(),
		publishBatch: vi.fn(),
		applyProgress: vi.fn(),
		caughtUp: vi.fn(),
		baselineSyncCompleted: vi.fn(),
		resetRequired: vi.fn(),
		decodeFailed: vi.fn(),
	};
	return {
		reconciliation,
		admitted: vi.fn(),
		disconnected: vi.fn(),
		failed: vi.fn(),
	};
}
