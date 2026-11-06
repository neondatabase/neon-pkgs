---
"neon": minor
---

`neon env pull` writes `NEON_BRANCH_ID` and `NEON_FUNCTION_HOST_SUFFIX`, the variables `functionBaseUrl(slug)` from `@neon/env` reads and the Functions runtime injects, instead of one `NEON_FUNCTION_<SLUG>_BASE_URL` per function. An unscoped or `-s functions` pull removes the old lines, and `-e NEON_FUNCTION_<SLUG>_BASE_URL` fails with a pointer to `functionBaseUrl`. `neon dev` sets `NEON_DEV_FUNCTION_PORTS` so `functionBaseUrl` returns `http://localhost:<port>` for the functions it serves.
