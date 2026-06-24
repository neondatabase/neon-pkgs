/**
 * `waitUntil(promise)` defers async work past a Neon Function's response: the runtime
 * keeps the invocation alive until the promise settles (up to the 15-minute limit).
 *
 * The runtime publishes the active invocation context on `globalThis.NEON_REQUEST_CONTEXT`
 * (a getter returning `{ waitUntil }` during an invocation, `undefined` outside one), so we
 * read it directly. Off-platform — local dev, tests, non-Neon hosts — there is no context
 * and this is a no-op, mirroring `@vercel/functions`: the promise the caller created still
 * runs on its own, it just isn't tracked. Passing a non-Promise throws a `TypeError`.
 */

declare global {
	// Published by the Neon Functions runtime. Declared here (the only way to type an
	// augmented global) so it can be read off `globalThis` without a cast. `var` is the
	// required form for a global augmentation.
	var NEON_REQUEST_CONTEXT:
		| { waitUntil?: (promise: Promise<unknown>) => void }
		| undefined;
}

function isPromise(value: unknown): value is Promise<unknown> {
	return (
		typeof value === "object" &&
		value !== null &&
		"then" in value &&
		typeof value.then === "function"
	);
}

export function waitUntil(promise: Promise<unknown>): void {
	if (!isPromise(promise)) {
		throw new TypeError(
			`waitUntil can only be called with a Promise, got ${typeof promise}`,
		);
	}
	globalThis.NEON_REQUEST_CONTEXT?.waitUntil?.(promise);
}
