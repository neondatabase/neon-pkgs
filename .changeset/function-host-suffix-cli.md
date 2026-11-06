---
"neon": major
---

**Breaking:** `neon env pull` writes `NEON_BRANCH_ID` and `NEON_FUNCTION_HOST_SUFFIX`, the variables `functionBaseUrl(slug)` from `@neon/env` 2 reads and the Functions runtime injects, instead of one `NEON_FUNCTION_<SLUG>_BASE_URL` per function. An unscoped or `-s functions` pull removes the old lines, `-e NEON_FUNCTION_<SLUG>_BASE_URL` fails with a pointer to `functionBaseUrl`, and `neon dev` sets `NEON_DEV_FUNCTION_PORTS` instead of per-function localhost URLs. Apps reading `env.functions` from `@neon/env` 1.x need `@neon/env` 2 and `functionBaseUrl("<slug>")`.
