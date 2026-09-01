---
"neon": minor
"neonctl": minor
"@neon/env": minor
---

`neon env pull` writes `NEON_FUNCTION_<SLUG>_BASE_URL` for each deployed function. A `neon.ts` requires a live URL for every declared slug; `--service functions` and `--env NEON_FUNCTION_*_BASE_URL` list every live function. `parseEnv` / `fetchEnv` type `env.functions.<slug>.baseUrl` as `string`.
