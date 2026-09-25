---
"@neon/sdk": patch
---

Refresh the vendored Neon API spec. `synthetic_storage_size_bytes` on consumption history v1 responses is now marked `@deprecated` (the API always returns 0; use the v2 consumption history endpoints), and `@neon/sdk/raw` exports the new `ScimToken` schema types.
