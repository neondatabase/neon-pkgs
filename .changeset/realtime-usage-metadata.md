---
"@neon/realtime": patch
"@neon/realtime-drizzle": patch
"@neon/realtime-kysely": patch
---

Send bounded SDK release-line and query-source metadata for aggregate Realtime
usage metrics. Protocol v2 clients send one `client_info` message after `ready`
and before subscription commands; sealed capabilities use capability v2.
Official Drizzle and Kysely adapters identify their query source, while custom
adapters default to the fixed `custom` category.
