import { describe, expect, it } from "vitest";

import {
	NEON_REQUEST_CONTEXT_KEY,
	runWithRequestContext,
	waitUntil,
} from "./wait-until.js";

describe("waitUntil", () => {
	it("reads the context directly off globalThis[NEON_REQUEST_CONTEXT_KEY] (runtime shape)", () => {
		// The runtime publishes the live context object DIRECTLY under this key (a
		// getter returning `{ waitUntil }`), not a `.get()`-style provider. Simulate
		// that and assert we forward to it.
		const received: Promise<unknown>[] = [];
		const promise = Promise.resolve();
		const original = Object.getOwnPropertyDescriptor(
			globalThis,
			NEON_REQUEST_CONTEXT_KEY,
		);
		try {
			Object.defineProperty(globalThis, NEON_REQUEST_CONTEXT_KEY, {
				configurable: true,
				get: () => ({
					waitUntil: (p: Promise<unknown>) => received.push(p),
				}),
			});
			waitUntil(promise);
			expect(received).toEqual([promise]);
		} finally {
			if (original) {
				Object.defineProperty(
					globalThis,
					NEON_REQUEST_CONTEXT_KEY,
					original,
				);
			}
		}
	});

	it("forwards the promise to the invocation context's waitUntil", () => {
		const received: Promise<unknown>[] = [];
		const promise = Promise.resolve("done");

		runWithRequestContext({ waitUntil: (p) => received.push(p) }, () => {
			waitUntil(promise);
		});

		expect(received).toEqual([promise]);
	});

	it("resolves the context at call time, including from nested async work", async () => {
		const received: Promise<unknown>[] = [];
		const promise = Promise.resolve();

		await runWithRequestContext(
			{ waitUntil: (p) => received.push(p) },
			async () => {
				await Promise.resolve();
				waitUntil(promise);
			},
		);

		expect(received).toEqual([promise]);
	});

	it("isolates context across concurrent invocations", async () => {
		const a: Promise<unknown>[] = [];
		const b: Promise<unknown>[] = [];
		const pa = Promise.resolve("a");
		const pb = Promise.resolve("b");

		await Promise.all([
			runWithRequestContext({ waitUntil: (p) => a.push(p) }, async () => {
				await Promise.resolve();
				waitUntil(pa);
			}),
			runWithRequestContext({ waitUntil: (p) => b.push(p) }, async () => {
				await Promise.resolve();
				waitUntil(pb);
			}),
		]);

		expect(a).toEqual([pa]);
		expect(b).toEqual([pb]);
	});

	it("is a no-op when no invocation context is in scope", () => {
		expect(() => waitUntil(Promise.resolve())).not.toThrow();
	});

	it("is a no-op when the context exposes no waitUntil", () => {
		runWithRequestContext({}, () => {
			expect(() => waitUntil(Promise.resolve())).not.toThrow();
		});
	});

	it("throws a TypeError when called without a promise", () => {
		// @ts-expect-error — exercising the runtime guard for untyped JS callers.
		expect(() => waitUntil(42)).toThrow(TypeError);
	});
});
