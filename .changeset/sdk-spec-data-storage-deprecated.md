---
"@neon/sdk": patch
---

Refresh the vendored Neon API spec. `data_storage_bytes_hour` on `Project` and on consumption history v1 timeframes is now marked `@deprecated` (the API always returns 0; use the v2 consumption history endpoints), and it is typed as always present on consumption timeframes, matching what the API returns.
