---
"neon": patch
---

`neon realtime subscribe` now says why Realtime rejected a query. It printed only `upstream rejected` for every rejection, because it subscribed without Realtime's `debugMode`. It now subscribes in `debugMode` by default, since it already runs with the branch's Realtime secret and connection string, and prints the reason with the Realtime error code and the PostgreSQL SQLSTATE when there is one: `column "nope" does not exist (upstream_rejected, SQLSTATE 42703)` or `unsupported query: set-returning function (upstream_rejected)`. Some failures, such as `baseline_sync_failed`, still carry no detail beyond the code. Pass `--no-debug` (or `--debug false`) to subscribe without `debugMode` and see the safe errors a browser client gets.
