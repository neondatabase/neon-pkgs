---
"neon": patch
---

`databases delete` and `roles delete` report when the target is already gone (HTTP 204) instead of printing nothing. Table mode prints the message on stderr; JSON/YAML emit `{ deleted: false, message }` on stdout. The exit code stays 0.
