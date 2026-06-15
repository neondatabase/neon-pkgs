# @neondatabase/functions

## 0.2.0

### Minor Changes

- Implement `waitUntil` with a Vercel-compatible API (replaces the no-op placeholder).

  `waitUntil` is now called directly with a promise — `waitUntil(promise)` — matching
  `@vercel/functions` instead of returning a deferred function. The per-invocation
  context is carried by an `AsyncLocalStorage` and published on
  `globalThis[NEON_FUNCTIONS_CONTEXT]` (a `Symbol.for("@neondatabase/functions/request-context")`)
  as a `{ get() }` provider, mirroring the contract used by Vercel and Next.js. Because
  the context lives in `AsyncLocalStorage`, concurrent invocations sharing an isolate no
  longer clobber each other's context.

  A non-`Promise` argument throws a `TypeError`. When no invocation context is in scope
  (local dev, tests, non-Neon hosts), `waitUntil` is a no-op, so the same code runs
  everywhere. The new `runWithRequestContext(context, fn)` helper lets the runtime bind a
  context for the duration of an invocation.

## 0.1.0

### Minor Changes

- Initial release of `@neondatabase/functions` — runtime helpers for Neon Functions.

  - `waitUntil()` — returns a function for deferring background work past a response, mirroring the Cloudflare Workers / Vercel `ctx.waitUntil(promise)` primitive.

  > **Not implemented yet.** `waitUntil()` currently returns a no-op placeholder; the promise is accepted and ignored until the Neon Functions runtime integration ships.
