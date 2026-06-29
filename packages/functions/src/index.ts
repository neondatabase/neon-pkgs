/**
 * `@neon/functions` — runtime helpers for Neon Functions.
 *
 * - `waitUntil(promise)` — defers async work past the response by handing the promise to
 *   the current invocation context. No-op off-platform (local dev, tests, non-Neon hosts).
 *   Mirrors `@vercel/functions`.
 */

export { waitUntil } from "./lib/wait-until.js";
