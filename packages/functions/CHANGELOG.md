# @neondatabase/functions

## 0.5.0

### Minor Changes

- Simplify the package to expose only `waitUntil`.

  `waitUntil` now reads the runtime context straight off `globalThis.NEON_REQUEST_CONTEXT` with no internal `AsyncLocalStorage`. The unused `runWithRequestContext` export and the `NEON_REQUEST_CONTEXT_KEY` constant (plus the `NeonFunctionsContext`/`WaitUntil` type exports) are removed — the runtime publishes the context itself, so none of that surface was used. Behavior is unchanged: forwards to the runtime on-platform, no-op off-platform (matching `@vercel/functions`).

## 0.4.0

### Minor Changes

- 75cf53a: Fix `waitUntil` so it actually picks up the runtime invocation context.

  The package was looking for the context under a `Symbol.for("@neondatabase/functions/request-context")` key and expected a Vercel/Next-style provider object with a `.get()` method. The Neon Functions runtime instead publishes the context as a getter on the plain `globalThis.NEON_REQUEST_CONTEXT` key that returns the context object (`{ waitUntil }`) directly. Both the key and the shape were mismatched, so `getContext()` always returned `{}` and `waitUntil` silently no-op'd on-platform.

  `waitUntil` now reads `globalThis.NEON_REQUEST_CONTEXT` directly (no `.get()` indirection). The off-platform no-op behavior is unchanged (matches `@vercel/functions`).

  The exported `NEON_FUNCTIONS_CONTEXT` symbol is replaced by the `NEON_REQUEST_CONTEXT_KEY` string constant that reflects the real runtime key.

## 0.3.0

### Minor Changes

- Drop the `/v1` subpath export — import everything from the package root instead.

  `@neondatabase/env/v1`, `@neondatabase/functions/v1`, and `@neondatabase/ai-sdk-provider/v1` are no longer published. Use the package root (`@neondatabase/env`, `@neondatabase/functions`, `@neondatabase/ai-sdk-provider`), which already exposed the full surface. Versioned subpath exports remain only on `@neondatabase/config` and `@neondatabase/config-runtime`, where pinning a policy-schema major is meaningful.

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
