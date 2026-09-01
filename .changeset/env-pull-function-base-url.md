---
"neon": minor
"neonctl": minor
"@neon/env": minor
---

`neon env pull` writes `NEON_FUNCTION_<SLUG>_BASE_URL` for each deployed function. A `neon.ts` intersects declared slugs with live URLs; `--service functions` and `--env NEON_FUNCTION_*_BASE_URL` list every live function. `parseEnv` / `fetchEnv` expose `env.functions.<slug>.baseUrl` when the policy declares functions.
