---
"neon": minor
---

`neon init` now records why a run failed. The `cli_init_end` analytics event gains `failed_step` (`plugins`, `skills`, `mcp`, `config`, `env_pull`, or `other`) and `error_kind` (a coarse reason such as `permission_denied`, `network` or `registry_blocked`), both `null` unless the run ended in `error`. Every error that leaves `neon init` carries the run's `init_run_id`, so it can be joined to `cli_init_start` and `cli_init_end`. Nothing changes in what `neon init` prints, and nothing is sent with `--no-analytics`.
