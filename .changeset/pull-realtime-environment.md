---
"@neon/config": minor
"@neon/config-runtime": minor
"@neon/env": minor
"neon": minor
---

Expose the Realtime WebSocket URL and server-only secret through `@neon/env` and `neon env pull`. Config-aware pulls wait for asynchronous Realtime provisioning before returning `NEON_REALTIME_URL` and `NEON_REALTIME_SECRET`; applications derive the database name from `DATABASE_URL`.
