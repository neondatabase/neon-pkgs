---
"neon": minor
---

`databases delete` and `roles delete` report when the target is already gone (HTTP 204) instead of printing nothing. `roles delete` then exits 1.
