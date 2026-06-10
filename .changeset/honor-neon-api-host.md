---
"@neondatabase/config": patch
"@neondatabase/config-runtime": patch
"@neondatabase/env": patch
---

Honor `NEON_API_HOST` / the new `apiHost` option when building the default Neon API client. `createNeonApiFromOptions` now resolves the host (explicit `apiHost` option → `NEON_API_HOST` env → production default), and `pullConfig`, `pushConfig`, `inspect`/`plan`/`apply`, and `fetchEnv` accept and forward an optional `apiHost`.
