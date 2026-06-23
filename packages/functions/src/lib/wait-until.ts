/**
 * `waitUntil` extends the lifetime of a Neon Function invocation so background work
 * (logging, cache writes, analytics, …) can finish after the response has been sent.
 *
 * The public API mirrors Vercel's `@vercel/functions`: import `waitUntil` and call it
 * directly with a promise (`waitUntil(promise)`). The active invocation context is
 * published by the runtime on `globalThis`, so it can be read without importing the
 * runtime and stays correct under concurrency.
 */
import { AsyncLocalStorage } from "node:async_hooks";

export type WaitUntil = (promise: Promise<unknown>) => void;

/**
 * The slice of the runtime context this package reads. The runtime may attach
 * additional fields; only `waitUntil` is consumed here.
 */
export type NeonFunctionsContext = {
	waitUntil?: WaitUntil;
};

/**
 * Well-known `globalThis` key under which the Neon Functions runtime publishes the
 * current invocation context. The runtime installs it as a getter that returns the
 * live context object DIRECTLY — `globalThis.NEON_REQUEST_CONTEXT` is `{ waitUntil }`
 * during an invocation and `undefined` outside one — so it is read as the context
 * itself, not via a `.get()`-style provider.
 */
export const NEON_REQUEST_CONTEXT_KEY = "NEON_REQUEST_CONTEXT";

type GlobalWithContext = typeof globalThis & {
	[NEON_REQUEST_CONTEXT_KEY]?: NeonFunctionsContext;
};

const globalWithContext: GlobalWithContext = globalThis;

/**
 * Backs `runWithRequestContext` for local dev and tests. When the runtime is present
 * it has already published its own accessor under the same key, so we leave that in
 * place and never publish over it.
 */
const requestContextStore = new AsyncLocalStorage<NeonFunctionsContext>();

if (!(NEON_REQUEST_CONTEXT_KEY in globalWithContext)) {
	Object.defineProperty(globalWithContext, NEON_REQUEST_CONTEXT_KEY, {
		configurable: true,
		get() {
			return requestContextStore.getStore();
		},
	});
}

/**
 * Reads the current invocation context off `globalThis.NEON_REQUEST_CONTEXT`, falling
 * back to an empty context outside an invocation (local dev, tests, non-Neon hosts).
 */
function getContext(): NeonFunctionsContext {
	return globalWithContext[NEON_REQUEST_CONTEXT_KEY] ?? {};
}

function isPromise(value: unknown): value is Promise<unknown> {
	return (
		typeof value === "object" &&
		value !== null &&
		"then" in value &&
		typeof value.then === "function"
	);
}

/**
 * Defers async work past the response by forwarding the promise to the Neon Functions
 * runtime, which keeps the invocation alive until the promise settles.
 *
 * The context is resolved at call time from the enclosing invocation, so this stays
 * correct under concurrency. When no invocation context is in scope (local dev, tests,
 * non-Neon hosts), this is a no-op: the promise is accepted and ignored (it still runs
 * on its own — the caller already started it — it just isn't tracked).
 */
export function waitUntil(promise: Promise<unknown>): void {
	if (!isPromise(promise)) {
		throw new TypeError(
			`waitUntil can only be called with a Promise, got ${typeof promise}`,
		);
	}
	getContext().waitUntil?.(promise);
}

/**
 * Runtime entry point: binds `context` as the current invocation context for the
 * duration of `fn` (and any async work it spawns), so calls to `waitUntil` inside it
 * forward to `context.waitUntil`. Intended for the Neon Functions runtime to wrap each
 * invocation; application code should not need this.
 */
export function runWithRequestContext<T>(
	context: NeonFunctionsContext,
	fn: () => T,
): T {
	return requestContextStore.run(context, fn);
}
