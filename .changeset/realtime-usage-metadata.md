---
"@neon/realtime": patch
"@neon/realtime-drizzle": patch
"@neon/realtime-kysely": patch
---

Send bounded SDK release-line and query-source metadata for aggregate Realtime
usage metrics. The browser now uses `neon.realtime.v3`; sealed capabilities use
capability v2. Official Drizzle and Kysely adapters identify their query source,
while custom adapters default to the fixed `custom` category.
