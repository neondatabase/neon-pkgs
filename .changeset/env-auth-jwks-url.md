---
"@neondatabase/env": patch
---

Surface the Neon Auth JWKS URL as `NEON_AUTH_JWKS_URL`.

When a branch policy enables `auth`, `fetchEnv` / `parseEnv` / `toEntries` now expose
`env.auth.jwksUrl` (`NEON_AUTH_JWKS_URL`) alongside the existing `env.auth.baseUrl`, so
apps and agents get the JWKS endpoint needed to verify Neon Auth tokens — not just the base
URL. `fetchEnv` reads it from the live integration's `jwks_url`; `parseEnv` reads and
validates it from `process.env`.
