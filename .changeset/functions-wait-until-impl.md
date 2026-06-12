---
"@neondatabase/functions": minor
---

Implement `waitUntil()` (replaces the no-op placeholder).

The function returned by `waitUntil()` now forwards the promise to the Neon Functions runtime via its per-invocation context (`globalThis[NEON_FUNCTIONS_CONTEXT]`, a `Symbol.for("@neondatabase/functions/request-context")`), keeping the invocation alive until the promise settles. Behaviour mirrors Vercel's `waitUntil`: a non-`Promise` argument throws a `TypeError`. When the runtime has not published a context (local dev, tests, non-Neon hosts), the returned function is a no-op, so the same code runs everywhere. The `NEON_FUNCTIONS_CONTEXT` symbol is now exported as the documented runtime contract.
