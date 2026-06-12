import { afterEach, describe, expect, it } from "vitest";

import { NEON_FUNCTIONS_CONTEXT, waitUntil } from "./wait-until.js";

type GlobalWithContext = typeof globalThis & {
	[NEON_FUNCTIONS_CONTEXT]?: {
		waitUntil?: (promise: Promise<unknown>) => void;
	};
};

const globalWithContext: GlobalWithContext = globalThis;

afterEach(() => {
	delete globalWithContext[NEON_FUNCTIONS_CONTEXT];
});

describe("waitUntil", () => {
	it("forwards the promise to the runtime-provided waitUntil", () => {
		const received: Promise<unknown>[] = [];
		globalWithContext[NEON_FUNCTIONS_CONTEXT] = {
			waitUntil: (promise) => {
				received.push(promise);
			},
		};

		const defer = waitUntil();
		const promise = Promise.resolve("done");
		defer(promise);

		expect(received).toEqual([promise]);
	});

	it("resolves the context lazily, when the deferred function is called", () => {
		const defer = waitUntil();

		const received: Promise<unknown>[] = [];
		globalWithContext[NEON_FUNCTIONS_CONTEXT] = {
			waitUntil: (promise) => {
				received.push(promise);
			},
		};

		const promise = Promise.resolve();
		defer(promise);

		expect(received).toEqual([promise]);
	});

	it("is a no-op when the runtime context is absent", () => {
		const defer = waitUntil();
		expect(() => defer(Promise.resolve())).not.toThrow();
	});

	it("is a no-op when the context exposes no waitUntil", () => {
		globalWithContext[NEON_FUNCTIONS_CONTEXT] = {};
		const defer = waitUntil();
		expect(() => defer(Promise.resolve())).not.toThrow();
	});

	it("throws a TypeError when called without a promise", () => {
		const defer = waitUntil();
		// @ts-expect-error — exercising the runtime guard for untyped JS callers.
		expect(() => defer(42)).toThrow(TypeError);
	});
});
