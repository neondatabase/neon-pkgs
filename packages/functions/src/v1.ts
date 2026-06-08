/**
 * `@neondatabase/functions/v1` — runtime helpers for Neon Functions.
 *
 * - `waitUntil()` — returns a function that defers async work past the response.
 *   Currently a no-op placeholder; the runtime integration is not implemented yet.
 */

export type { WaitUntil } from "./lib/wait-until.js";
export { waitUntil } from "./lib/wait-until.js";
