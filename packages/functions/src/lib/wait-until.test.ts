import { describe, expect, it } from "vitest";

import { runWithRequestContext, waitUntil } from "./wait-until.js";

describe("waitUntil", () => {
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
