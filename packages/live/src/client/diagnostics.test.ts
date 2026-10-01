import { afterEach, describe, expect, it, vi } from "vitest";
import { createNeonLiveDiagnostics } from "./diagnostics.js";
import type { NeonLiveLogEntry } from "./types.js";

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe("Neon Live client diagnostics", () => {
	it("is silent by default", () => {
		const logger = vi.fn();
		const diagnostics = createNeonLiveDiagnostics({ logger });

		diagnostics.log("error", "connection_failed", "failed");

		expect(logger).not.toHaveBeenCalled();
	});

	it("filters entries at the configured minimum level", () => {
		vi.useFakeTimers();
		vi.setSystemTime(123);
		const entries: NeonLiveLogEntry[] = [];
		const diagnostics = createNeonLiveDiagnostics({
			logLevel: "warn",
			logger: (entry) => entries.push(entry),
		});

		diagnostics.log("debug", "connection_attempt_started", "attempt");
		diagnostics.log("info", "connection_ready", "ready");
		diagnostics.log("warn", "connection_lost", "lost", {
			activeSubscriptionCount: 2,
		});
		diagnostics.log("error", "connection_failed", "failed");

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

	it("never lets a logger failure interrupt the client", () => {
		const diagnostics = createNeonLiveDiagnostics({
			logLevel: "error",
			logger: () => {
				throw new Error("logger failed");
			},
		});

		expect(() =>
			diagnostics.log("error", "connection_failed", "failed"),
		).not.toThrow();
	});

	it("uses the matching console method when no logger is supplied", () => {
		const warn = vi
			.spyOn(console, "warn")
			.mockImplementation(() => undefined);
		const diagnostics = createNeonLiveDiagnostics({ logLevel: "warn" });

		diagnostics.log("warn", "connection_lost", "lost");

		expect(warn).toHaveBeenCalledWith(
			expect.objectContaining({
				level: "warn",
				event: "connection_lost",
			}),
		);
	});

	it("allocates opaque client-local subscription IDs", () => {
		const diagnostics = createNeonLiveDiagnostics({});

		expect(diagnostics.nextSubscriptionId()).toBe("s1");
		expect(diagnostics.nextSubscriptionId()).toBe("s2");
	});
});
