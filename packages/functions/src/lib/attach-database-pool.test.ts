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
		expect(error).toHaveBeenCalledWith(
			"attachDatabasePool: unexpected database pool error",
			err,
		);
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
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const first = vi.fn();
		const second = vi.fn();
		const pool = new EventEmitter();
		attachDatabasePool(pool, { onUnexpectedError: first });
		attachDatabasePool(pool, { onUnexpectedError: second });

		pool.emit("error", new Error("unexpected"));

		expect(pool.listenerCount("error")).toBe(1);
		expect(first).toHaveBeenCalledTimes(1);
		expect(second).not.toHaveBeenCalled();
		expect(warn).toHaveBeenCalledTimes(1);
	});

	it("does not warn when a second call passes no reporter", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const pool = new EventEmitter();
		attachDatabasePool(pool);
		attachDatabasePool(pool);

		expect(warn).not.toHaveBeenCalled();
		expect(pool.listenerCount("error")).toBe(1);
	});

	it("logs and does not throw when onUnexpectedError returns a rejected promise", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const reporterError = new Error("sentry down");
		const pool = new EventEmitter();
		attachDatabasePool(pool, {
			onUnexpectedError: async () => {
				throw reporterError;
			},
		});
		const err = new Error("unexpected");

		expect(() => pool.emit("error", err)).not.toThrow();
		await vi.waitFor(() => {
			expect(error).toHaveBeenCalledWith(
				"attachDatabasePool: unexpected database pool error",
				err,
			);
			expect(error).toHaveBeenCalledWith(
				"attachDatabasePool: onUnexpectedError threw",
				reporterError,
			);
		});
	});

	it("logs and does not throw when onUnexpectedError throws", () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const reporterError = new Error("sentry down");
		const pool = new EventEmitter();
		attachDatabasePool(pool, {
			onUnexpectedError: () => {
				throw reporterError;
			},
		});
		const err = new Error("unexpected");

		expect(() => pool.emit("error", err)).not.toThrow();
		expect(error).toHaveBeenCalledWith(
			"attachDatabasePool: unexpected database pool error",
			err,
		);
		expect(error).toHaveBeenCalledWith(
			"attachDatabasePool: onUnexpectedError threw",
			reporterError,
		);
	});

	it("throws a TypeError when the argument is not a pool", () => {
		// @ts-expect-error Invalid inputs are possible from JavaScript.
		expect(() => attachDatabasePool(null)).toThrow(TypeError);
		// @ts-expect-error Invalid inputs are possible from JavaScript.
		expect(() => attachDatabasePool(42)).toThrow(TypeError);
		// @ts-expect-error Invalid inputs are possible from JavaScript.
		expect(() => attachDatabasePool({})).toThrow(
			/requires a node-postgres Pool with an on\(\) method/,
		);
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
