---
"@neon/sdk": patch
---

`createNeonClient` now retries a `GET` whose connection dropped before a response (`ECONNRESET`, `EPIPE`, `UND_ERR_SOCKET`) within the `retries` budget. This includes the lookups in `postgres.connectionString`, which also start retrying `423`, `429`, and `503`.
