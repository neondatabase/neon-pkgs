import { afterEach, describe, expect, it } from "vitest";

import { waitUntil } from "./wait-until.js";

afterEach(() => {
	globalThis.NEON_REQUEST_CONTEXT = undefined;
});

describe("waitUntil", () => {
	it("forwards the promise to the runtime context's waitUntil", () => {
		const received: Promise<unknown>[] = [];
		globalThis.NEON_REQUEST_CONTEXT = {
			waitUntil: (p) => received.push(p),
		};
		const promise = Promise.resolve("done");

		waitUntil(promise);

		expect(received).toEqual([promise]);
	});

	it("reads the context at call time, so a later-published context is picked up", () => {
		const received: Promise<unknown>[] = [];
		const promise = Promise.resolve();

		// No context published yet → no-op.
		waitUntil(Promise.resolve());
		expect(received).toEqual([]);

		globalThis.NEON_REQUEST_CONTEXT = {
			waitUntil: (p) => received.push(p),
		};
		waitUntil(promise);
		expect(received).toEqual([promise]);
	});

	it("is a no-op when no invocation context is published", () => {
		expect(() => waitUntil(Promise.resolve())).not.toThrow();
	});

	it("is a no-op when the context exposes no waitUntil", () => {
		globalThis.NEON_REQUEST_CONTEXT = {};
		expect(() => waitUntil(Promise.resolve())).not.toThrow();
	});

	it("throws a TypeError when called without a promise", () => {
		// @ts-expect-error — exercising the runtime guard for untyped JS callers.
		expect(() => waitUntil(42)).toThrow(TypeError);
	});
});
