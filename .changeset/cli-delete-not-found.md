---
"neon": minor
---

`databases delete` and `roles delete` report when the target is already gone (HTTP 204) instead of printing nothing. JSON includes `deleted: false`. `roles delete` of a missing name now exits 1, so scripts that treated that 204 as success will fail.
