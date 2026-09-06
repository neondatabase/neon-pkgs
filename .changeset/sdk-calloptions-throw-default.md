---
"@neon/sdk": major
---

`CallOptions` now defaults `Throw` to `false`, matching the client. A `CallOptions` variable keeps the `{ data, error }` envelope. Use `CallOptions<true>` when `throwOnError` is true.
