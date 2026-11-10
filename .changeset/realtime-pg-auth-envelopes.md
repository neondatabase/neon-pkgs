---
"@neon/realtime": patch
---

Seal Realtime queries with Postgres credentials instead of the Realtime secret. `createRealtime({ databaseUrl, url })` seals each query into an HPKE (P-256) envelope addressed to the branch's public key, carrying the connection string's user and password; Realtime checks them with a Postgres login. With no password in `databaseUrl`, the credential is an OIDC token, by default Vercel's runtime token, or one from `oidcToken`. Only `neondb_owner` is supported for now. The SDK fetches the branch key from `/.well-known/neon-realtime-keys` on the Realtime host and caches it for up to 10 minutes. `createRealtime({ secret, db })` keeps working, and the SDK never falls back to the secret when `databaseUrl` is set. The browser client accepts the new envelopes. `fetchRealtimeKey()` and `sealRealtimeEnvelope()` are low-level helpers for tooling and tests, and the v3 envelope schema is exported as `@neon/realtime/schema/realtime-query-capability-v3.schema.json`.
