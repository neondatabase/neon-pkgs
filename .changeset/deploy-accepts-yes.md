---
"neon": patch
---

`neon deploy` and `neon config apply` accept `-y` / `--yes`, like `neon init` and `neon link`, instead of failing with `Unknown argument: y`. The flag has no effect: both commands never prompt, and overriding remote settings still needs `--update-existing`.
