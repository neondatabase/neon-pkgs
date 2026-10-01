import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { createClientEventSink } from "./diagnostics.js";
import type { NeonLiveLogEntry } from "./types.js";

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe("Neon Live client diagnostics", () => {
	it("rejects invalid diagnostic configuration", () => {
		expect(() =>
			createClientEventSink({
				logLevel: "verbose" as never,
			}),
		).toThrow("Invalid Neon Live log level");
		expect(() =>
			createClientEventSink({
				logger: {} as never,
			}),
		).toThrow("Neon Live logger must be a function");
	});

	it("is silent by default", async () => {
		const logger = vi.fn();
		const events = createClientEventSink({ logger });

		events.connection.failed(diagnosticError("connection_failed", false));
		await flushDiagnostics();

		expect(logger).not.toHaveBeenCalled();
		expect(events.createSubscription()).toBe(events.createSubscription());
	});

	it("filters entries at the configured minimum level", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(123);
		const entries: NeonLiveLogEntry[] = [];
		const events = createClientEventSink({
			logLevel: "warn",
			logger: (entry) => entries.push(entry),
		});

		events.connection.attemptStarted();
		events.connection.ready();
		events.connection.lost(undefined, 2);
		events.connection.failed(diagnosticError("connection_failed", false));
		await vi.runAllTicks();

		expect(entries).toEqual([
			expect.objectContaining({
				level: "warn",
				event: "connection_lost",
				timestamp: 123,
				activeSubscriptionCount: 2,
			}),
			expect.objectContaining({
				level: "error",
				event: "connection_failed",
				timestamp: 123,
			}),
		]);
		expect(Object.isFrozen(entries[0])).toBe(true);
	});

	it("dispatches after the state transition that emitted the event", async () => {
		let transitionComplete = false;
		const observations: boolean[] = [];
		const events = createClientEventSink({
			logLevel: "info",
			logger: () => observations.push(transitionComplete),
		});

		events.connection.ready();
		expect(observations).toEqual([]);
		transitionComplete = true;
		await flushDiagnostics();

		expect(observations).toEqual([true]);
	});

	it("never lets a logger failure interrupt later entries", async () => {
		const delivered: string[] = [];
		const events = createClientEventSink({
			logLevel: "error",
			logger: (entry) => {
				if (delivered.length === 0) {
					delivered.push("thrown");
					throw new Error("logger failed");
				}
				delivered.push(entry.event);
			},
		});

		events.connection.failed(diagnosticError("first", false));
		events.connection.failed(diagnosticError("second", false));
		await flushDiagnostics();

		expect(delivered).toEqual(["thrown", "connection_failed"]);
	});

	it("ignores rejected async logger calls", async () => {
		const delivered: string[] = [];
		const events = createClientEventSink({
			logLevel: "error",
			logger: async (entry) => {
				delivered.push(entry.event);
				if (delivered.length === 1) {
					throw new Error("async logger failed");
				}
			},
		});

		events.connection.failed(diagnosticError("first", false));
		events.connection.failed(diagnosticError("second", false));
		await flushDiagnostics();
		await flushDiagnostics();

		expect(delivered).toEqual(["connection_failed", "connection_failed"]);
	});

	it("uses the matching console method when no logger is supplied", async () => {
		const warn = vi
			.spyOn(console, "warn")
			.mockImplementation(() => undefined);
		const events = createClientEventSink({ logLevel: "warn" });

		events.connection.lost(undefined, 0);
		await flushDiagnostics();

		expect(warn).toHaveBeenCalledWith(
			expect.objectContaining({
				level: "warn",
				event: "connection_lost",
			}),
		);
	});

	it("allocates opaque client-local subscription IDs", async () => {
		const entries: NeonLiveLogEntry[] = [];
		const events = createClientEventSink({
			logLevel: "debug",
			logger: (entry) => entries.push(entry),
		});

		events.createSubscription().started();
		events.createSubscription().started();
		await flushDiagnostics();

		expect(entries).toEqual([
			expect.objectContaining({ subscriptionId: "s1" }),
			expect.objectContaining({ subscriptionId: "s2" }),
		]);
	});

	it("narrows event-specific metadata", () => {
		const assertType = (entry: NeonLiveLogEntry) => {
			if (entry.event === "subscription_snapshot_completed") {
				expectTypeOf(entry.subscriptionId).toEqualTypeOf<string>();
				expectTypeOf(entry.chunkCount).toEqualTypeOf<number>();
			}
			if (entry.event === "connection_publication_committed") {
				expectTypeOf(entry.bodyCount).toEqualTypeOf<number>();
			}
		};

		expectTypeOf(assertType).toBeFunction();
	});
});

function diagnosticError(code: string, retryable: boolean) {
	return Object.assign(new Error(code), { code, retryable });
}

async function flushDiagnostics(): Promise<void> {
	await new Promise<void>((resolve) => queueMicrotask(resolve));
}
