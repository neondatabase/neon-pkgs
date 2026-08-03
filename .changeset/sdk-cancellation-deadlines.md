---
"@neon/sdk": minor
---

Make cancellation work, and let a call be bounded.

`CallOptions.signal` was documented on every method but never reached the request: the
execution core passed only the client into each generated call, so aborting a call let it
run to completion. The one place a signal did have an effect — interrupting the sleep
between retries — rejected with a raw `DOMException`, so a client promising
`{ data, error }` threw, and a `throwOnError` client threw something that was not a
`NeonError`.

- **`signal` now reaches the request** on all 91 ergonomic call sites, plus paginated
  `list()`, and the multi-request `postgres.connectionString` resolver.
- **`requestTimeoutMs`** bounds a request and its retries, on the client or per call.
  Unset by default, so existing calls stay unbounded; pass `Infinity` on a call to opt out
  of a client-wide value. It is separate from `wait.timeoutMs`, which budgets readiness
  polling. Invalid values are rejected at construction rather than silently firing
  immediately.
- **New `NeonAbortError`** (`kind: "aborted"`) for caller cancellation, distinct from
  `NeonTimeoutError` (`kind: "timeout"`) because a timeout is worth retrying and a
  cancellation is not. Both arrive through the result envelope; neither escapes as a
  `DOMException`.
- **Paginated `list()` methods accept per-call options** after their query, so a walk can
  be cancelled or bounded like any other call. A deadline covers one consumption of the
  list rather than each page.
- **`Retry-After` is honoured, not capped.** It previously multiplied straight into a
  sleep, so `Retry-After: 3600` parked a call for an hour; the HTTP-date form parsed as
  `NaN` and fell through to generated backoff, retrying far sooner than instructed. The
  delay is never shortened now — when honouring it would exceed 10s or the remaining
  deadline, the SDK stops retrying and surfaces the real `423`/`429`/`503`.

Cancellation is classified from the SDK's own deadline state rather than by matching error
names, because the generated client reports auth, serialization, interceptor, transport and
parsing faults through one channel. A transport failure that merely looks like an abort
stays a `NeonNetworkError`.
