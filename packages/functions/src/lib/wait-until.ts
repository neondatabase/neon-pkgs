/**
 * `waitUntil` extends the lifetime of a Neon Function invocation so background work
 * (logging, cache writes, analytics, …) can finish after the response has been sent.
 *
 * It mirrors the platform primitive exposed by Cloudflare Workers / Vercel
 * (`ctx.waitUntil(promise)`).
 */
export type WaitUntil = (promise: Promise<unknown>) => void;

/**
 * Well-known `globalThis` key under which the Neon Functions runtime publishes the
 * per-invocation context. Mirrors the convention used by Vercel
 * (`Symbol.for("@vercel/request-context")`).
 *
 * The runtime assigns `globalThis[NEON_FUNCTIONS_CONTEXT]` before invoking the
 * handler. When it is absent (local dev, tests, non-Neon hosts), `waitUntil`
 * degrades to a no-op.
 */
export const NEON_FUNCTIONS_CONTEXT: unique symbol = Symbol.for(
	"@neondatabase/functions/request-context",
);

/**
 * The slice of the runtime context this package reads. The runtime may attach
 * additional fields; only `waitUntil` is consumed here.
 */
type NeonFunctionsContext = {
	waitUntil?: WaitUntil;
};

type GlobalWithContext = typeof globalThis & {
	[NEON_FUNCTIONS_CONTEXT]?: NeonFunctionsContext;
};

/**
 * Reads the current invocation context off `globalThis`, falling back to an empty
 * context when the runtime has not provided one.
 */
function getContext(): NeonFunctionsContext {
	const globalWithContext: GlobalWithContext = globalThis;
	return globalWithContext[NEON_FUNCTIONS_CONTEXT] ?? {};
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
 * Returns a `waitUntil` function for the current invocation.
 *
 * The returned function forwards the promise to the runtime-provided
 * `globalThis[NEON_FUNCTIONS_CONTEXT].waitUntil`, keeping the invocation alive until
 * the promise settles. When the runtime has not published a context (or it exposes
 * no `waitUntil`), the returned function is a no-op.
 *
 * The context is resolved lazily, when the returned function is called, so it stays
 * correct even if `waitUntil()` is invoked at module scope before the runtime has
 * wired up the request.
 */
export function waitUntil(): WaitUntil {
	return (promise: Promise<unknown>): void => {
		if (!isPromise(promise)) {
			throw new TypeError(
				`waitUntil can only be called with a Promise, got ${typeof promise}`,
			);
		}
		getContext().waitUntil?.(promise);
	};
}
