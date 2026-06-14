/**
 * `waitUntil` extends the lifetime of a Neon Function invocation so background work
 * (logging, cache writes, analytics, …) can finish after the response has been sent.
 *
 * The public API mirrors Vercel's `@vercel/functions`: import `waitUntil` and call it
 * directly with a promise (`waitUntil(promise)`). Under the hood the per-invocation
 * context is carried by an `AsyncLocalStorage`, so concurrent invocations sharing the
 * same isolate never clobber each other's context.
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
 * The accessor published on `globalThis` so consumers can read the current
 * invocation context without importing the runtime. Mirrors the provider shape
 * used by Vercel (`Symbol.for("@vercel/request-context")`) and Next.js
 * (`Symbol.for("@next/request-context")`): a stable object exposing `get()`.
 */
type RequestContextProvider = {
	get(): NeonFunctionsContext | undefined;
};

/**
 * Well-known `globalThis` symbol under which the per-invocation context provider is
 * published. Mirrors the convention used by Vercel and Next.js.
 */
export const NEON_FUNCTIONS_CONTEXT: unique symbol = Symbol.for(
	"@neondatabase/functions/request-context",
);

type GlobalWithContext = typeof globalThis & {
	[NEON_FUNCTIONS_CONTEXT]?: RequestContextProvider;
};

/**
 * Holds the per-invocation context. Each `runWithRequestContext(...)` call binds a
 * fresh context for the duration of its callback (and any async work it spawns), so
 * `waitUntil` always resolves to the right invocation even under concurrency.
 */
const requestContextStore = new AsyncLocalStorage<NeonFunctionsContext>();

const globalWithContext: GlobalWithContext = globalThis;

/**
 * Publish a stable provider whose `get()` reads the current store. Installed once;
 * if another copy of this module (or the host runtime) has already published a
 * provider, we leave it in place rather than clobber it.
 */
globalWithContext[NEON_FUNCTIONS_CONTEXT] ??= {
	get: () => requestContextStore.getStore(),
};

/**
 * Reads the current invocation context off the `globalThis` provider, falling back to
 * an empty context when no provider is published or no invocation is in scope.
 */
function getContext(): NeonFunctionsContext {
	return globalWithContext[NEON_FUNCTIONS_CONTEXT]?.get?.() ?? {};
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
 * non-Neon hosts), this is a no-op: the promise is accepted and ignored.
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
