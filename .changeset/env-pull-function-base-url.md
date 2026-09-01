---
"neon": minor
"neonctl": minor
"@neon/env": minor
---

`neon env pull` writes `NEON_FUNCTION_<SLUG>_BASE_URL` from the branch connection host for each `neon.ts` function (deployed or not). `--service functions` still lists live functions. `neon dev` injects `http://localhost:<port>`. `parseEnv` requires a URL; `fetchEnv` types `env.functions.<slug>.baseUrl` as `string`.
