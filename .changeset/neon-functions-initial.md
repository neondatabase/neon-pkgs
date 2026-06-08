---
"@neondatabase/functions": minor
---

Initial release of `@neondatabase/functions` — runtime helpers for Neon Functions.

- `waitUntil()` — returns a function for deferring background work past a response, mirroring the Cloudflare Workers / Vercel `ctx.waitUntil(promise)` primitive.

> **Not implemented yet.** `waitUntil()` currently returns a no-op placeholder; the promise is accepted and ignored until the Neon Functions runtime integration ships.
