---
"@neon/realtime": patch
"@neon/realtime-drizzle": patch
"@neon/realtime-kysely": patch
---

Delegate SQL and prepared-query validation to the Realtime proxy. ORM adapters now forward compiled queries without locally restricting their SQL shape, and `validateLiveSelectSql` is no longer exported from `@neon/realtime/server`.
