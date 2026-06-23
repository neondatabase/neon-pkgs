---
"@neondatabase/functions": minor
---

Fix `waitUntil` so it actually picks up the runtime invocation context.

The package was looking for the context under a `Symbol.for("@neondatabase/functions/request-context")` key and expected a Vercel/Next-style provider object with a `.get()` method. The Neon Functions runtime instead publishes the context as a getter on the plain `globalThis.NEON_REQUEST_CONTEXT` key that returns the context object (`{ waitUntil }`) directly. Both the key and the shape were mismatched, so `getContext()` always returned `{}` and `waitUntil` silently no-op'd on-platform.

`waitUntil` now reads `globalThis.NEON_REQUEST_CONTEXT` directly (no `.get()` indirection). The off-platform no-op behavior is unchanged (matches `@vercel/functions`).

The exported `NEON_FUNCTIONS_CONTEXT` symbol is replaced by the `NEON_REQUEST_CONTEXT_KEY` string constant that reflects the real runtime key.
