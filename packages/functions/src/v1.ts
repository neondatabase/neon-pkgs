/**
 * `@neondatabase/functions/v1` — runtime helpers for Neon Functions.
 *
 * - `waitUntil()` — returns a function that defers async work past the response by
 *   forwarding the promise to the runtime-provided context. No-op when the runtime
 *   has not published a context (local dev, tests, non-Neon hosts).
 * - `NEON_FUNCTIONS_CONTEXT` — the `globalThis` symbol under which the runtime
 *   publishes that context.
 */

export type { WaitUntil } from "./lib/wait-until.js";
export { NEON_FUNCTIONS_CONTEXT, waitUntil } from "./lib/wait-until.js";
