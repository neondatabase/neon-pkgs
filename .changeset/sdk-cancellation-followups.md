---
"@neon/sdk": patch
---

Close three gaps in the cancellation and deadline work.

- **A malformed `Retry-After` no longer causes an immediate retry.** Requiring
  `/^\d+$/` for delta-seconds sent invalid values on to `Date.parse`, which reads `-1`,
  `1.5` and `+5` as dates in 2001. Those are in the past, so the delay clamped to `0` and
  the SDK retried at once — the opposite of what the header asks. A numeric-looking value
  that is not valid delta-seconds is now rejected outright.
- **A `wait.timeoutMs` larger than `2147483647` no longer expires almost immediately.**
  `setTimeout` collapses any delay past that to 1ms (`TimeoutOverflowWarning`), and
  readiness budgets have always accepted arbitrarily large values. Deadline timers are
  re-armed in chunks, so a large budget behaves as written.
- **A `snapshots.restore` `preview` callback that throws no longer escapes the result
  contract.** A callback cooperating with its signal throws an `AbortError`, which
  propagated out of a client that promised `{ data, error }`. A throw is now reported as
  `NeonAbortError` when the signal fired and as a `client`-kind `NeonError` otherwise,
  both saying the restored branch is left un-finalized.

Also: a readiness timeout message counts the operations still outstanding rather than the
round's starting total, and the readiness tests now cancel and expire during an in-flight
poll instead of only between polls.
