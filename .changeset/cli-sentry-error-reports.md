---
"neon": minor
---

The CLI reports internal bugs (a `TypeError`, `ReferenceError`, `RangeError`, or `SyntaxError` that ends a command) to Neon's Sentry. Errors the CLI prints for you to act on are not reported. `--no-analytics` turns error reports off along with analytics.

`neon branches create --expires-at` and `neon branches set-expiration --expires-at` now reject a value that is not a date with `Invalid --expires-at value: "<value>". Use an RFC 3339 timestamp, e.g. 2025-12-31T23:59:59Z.` instead of `Invalid time value`.
