---
"neon": minor
---

The CLI reports internal bugs (a `TypeError`, `ReferenceError`, `RangeError`, or `SyntaxError` that ends a command) to Neon's Sentry. Errors the CLI prints for you to act on are not reported. `--no-analytics` turns error reports off along with analytics.
