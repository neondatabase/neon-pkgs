/**
 * `@neondatabase/functions` — runtime helpers for Neon Functions.
 *
 * - `waitUntil(promise)` — defers async work past the response by forwarding the
 *   promise to the current invocation context. No-op when no context is in scope
 *   (local dev, tests, non-Neon hosts). Mirrors `@vercel/functions`.
 * - `runWithRequestContext(context, fn)` — runtime entry point that binds a
 *   per-invocation context for the duration of `fn`. Used by the Neon Functions
 *   runtime; application code should not need it.
 * - `NEON_REQUEST_CONTEXT_KEY` — the `globalThis` key under which the runtime
 *   publishes the current invocation context.
 */

export type { NeonFunctionsContext, WaitUntil } from "./lib/wait-until.js";
export {
	NEON_REQUEST_CONTEXT_KEY,
	runWithRequestContext,
	waitUntil,
} from "./lib/wait-until.js";
