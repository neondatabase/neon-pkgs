---
"neon": minor
---

`databases delete` and `roles delete` report when the target is already gone (HTTP 204) instead of printing nothing. Table mode writes `ERROR:` on stderr and exits 1. JSON/YAML emit `{ deleted: false, message }` on stdout and exit 1.
