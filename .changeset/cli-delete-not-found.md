---
"neon": patch
---

`databases delete` and `roles delete` print a message on stderr when the target is already gone (HTTP 204) instead of printing nothing. Stdout and the exit code are unchanged.
