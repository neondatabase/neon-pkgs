import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

import { attachDatabasePool } from "./attach-database-pool.js";

class CodedError extends Error {
	constructor(
		message: string,
		readonly code?: string,
	) {
		super(message);
	}
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("attachDatabasePool", () => {
	it("does not throw when an idle client is dropped", () => {
		const pool = new EventEmitter();
		attachDatabasePool(pool);

		expect(() =>
			pool.emit("error", new CodedError("read ECONNRESET", "ECONNRESET")),
		).not.toThrow();
	});

	it("stays silent for expected idle disconnects", () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const pool = new EventEmitter();
		attachDatabasePool(pool);

		for (const err of [
			new CodedError("read ECONNRESET", "ECONNRESET"),
			new CodedError("write EPIPE", "EPIPE"),
			new CodedError("connect ETIMEDOUT", "ETIMEDOUT"),
			new CodedError(
				"terminating connection due to administrator command",
				"57P01",
			),
			new Error("Connection terminated unexpectedly"),
		]) {
			pool.emit("error", err);
		}

		expect(error).not.toHaveBeenCalled();
	});

	it("logs unexpected idle-client errors", () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const pool = new EventEmitter();
		attachDatabasePool(pool);
		const err = new CodedError(
			"password authentication failed for user",
			"28P01",
		);

		pool.emit("error", err);

		expect(error).toHaveBeenCalledTimes(1);
		expect(error).toHaveBeenCalledWith(err);
	});

	it("reports unexpected errors through onUnexpectedError instead of console.error", () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const onUnexpectedError = vi.fn();
		const pool = new EventEmitter();
		attachDatabasePool(pool, { onUnexpectedError });
		const err = new CodedError("crash", "57P02");

		pool.emit("error", err);

		expect(onUnexpectedError).toHaveBeenCalledTimes(1);
		expect(onUnexpectedError).toHaveBeenCalledWith(err);
		expect(error).not.toHaveBeenCalled();
	});

	it("does not call onUnexpectedError for expected idle disconnects", () => {
		const onUnexpectedError = vi.fn();
		const pool = new EventEmitter();
		attachDatabasePool(pool, { onUnexpectedError });

		pool.emit(
			"error",
			new CodedError(
				"terminating connection due to administrator command",
				"57P01",
			),
		);

		expect(onUnexpectedError).not.toHaveBeenCalled();
	});

	it("keeps the first attachment when called twice", () => {
		const first = vi.fn();
		const second = vi.fn();
		const pool = new EventEmitter();
		attachDatabasePool(pool, { onUnexpectedError: first });
		attachDatabasePool(pool, { onUnexpectedError: second });

		pool.emit("error", new Error("unexpected"));

		expect(pool.listenerCount("error")).toBe(1);
		expect(first).toHaveBeenCalledTimes(1);
		expect(second).not.toHaveBeenCalled();
	});

	it("does not record the pool if on() throws", () => {
		let calls = 0;
		const pool = {
			on: () => {
				calls += 1;
				if (calls === 1) {
					throw new Error("subscribe failed");
				}
			},
		};

		expect(() => attachDatabasePool(pool)).toThrow("subscribe failed");
		expect(() => attachDatabasePool(pool)).not.toThrow();
		expect(calls).toBe(2);
	});

	it("returns undefined", () => {
		expect(attachDatabasePool(new EventEmitter())).toBeUndefined();
	});

	it("throws a TypeError when the argument is not a pool", () => {
		// @ts-expect-error Invalid inputs are possible from JavaScript.
		expect(() => attachDatabasePool(null)).toThrow(TypeError);
		// @ts-expect-error Invalid inputs are possible from JavaScript.
		expect(() => attachDatabasePool(42)).toThrow(TypeError);
		// @ts-expect-error Invalid inputs are possible from JavaScript.
		expect(() => attachDatabasePool({})).toThrow(TypeError);
	});

	it("throws a TypeError when onUnexpectedError is not a function", () => {
		expect(() =>
			attachDatabasePool(new EventEmitter(), {
				// @ts-expect-error Invalid inputs are possible from JavaScript.
				onUnexpectedError: 42,
			}),
		).toThrow(TypeError);
	});

	it("throws a TypeError when options is not an object", () => {
		expect(() =>
			// @ts-expect-error Invalid inputs are possible from JavaScript.
			attachDatabasePool(new EventEmitter(), 42),
		).toThrow(TypeError);
	});
});
