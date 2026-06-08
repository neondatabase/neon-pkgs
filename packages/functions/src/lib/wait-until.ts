/**
 * `waitUntil` extends the lifetime of a Neon Function invocation so background work
 * (logging, cache writes, analytics, …) can finish after the response has been sent.
 *
 * It mirrors the platform primitive exposed by Cloudflare Workers / Vercel
 * (`ctx.waitUntil(promise)`).
 */
export type WaitUntil = (promise: Promise<unknown>) => void;

/**
 * Returns a `waitUntil` function for the current invocation.
 *
 * NOT IMPLEMENTED YET: this is a no-op placeholder. The returned function accepts a
 * promise and ignores it. Once the Neon Functions runtime ships, this will register the
 * promise with the host so the invocation stays alive until it settles.
 */
export function waitUntil(): WaitUntil {
	return (_promise: Promise<unknown>): void => {
		// no-op: the runtime integration is not implemented yet.
	};
}
