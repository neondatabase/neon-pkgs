---
"neon": patch
---

`neon init --services` and `neon config init --services` accept `postgres` for a Postgres-only `neon.ts`, alone or next to other services. `neon init --services none` no longer fails with `--services needs at least one service`; `none` still works on both commands but warns and will be removed.
