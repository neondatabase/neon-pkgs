---
"neon": patch
---

Report a request timeout as a timeout, not as a broken internet connection.

When the Neon API accepted a connection and then didn't answer within the 60s request
timeout, the CLI printed:

> Could not reach the Neon API. Please check your internet connection and try again.

The connection was fine and the request had reached the server, so the one thing the
message told the user to check was the one thing that was not wrong.

The timeout is raised inside the CLI's own `fetch` wrapper, so by the time it is
classified `@neon/sdk` has wrapped it as a `NeonNetworkError` — and the check looked only
at the top-level error's `name`, which is `NeonNetworkError` on every SDK path. The
timeout therefore fell through to the connectivity branch, whose message pattern matched
the SDK's own `Network error: …` text. A timeout is now raised as a CLI-owned error type
and recognised through the `cause` chain, so it reports `ECONNABORTED` and "Request timed
out" as intended.

`getApiClient` also accepts `requestTimeoutMs`, defaulting to the same 60s, which is what
makes the behaviour testable against a server that never responds. It is validated when
the client is built: without that, `-1`, `NaN`, `Infinity`, fractions and values above
`4294967295` throw from inside the fetch wrapper and come back as the same misleading
connectivity error, while `0` and the band from `2147483648` to `4294967295` are accepted
and make every request time out at once.
