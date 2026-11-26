---
"@neon/tools": patch
---

SQL tools no longer fail when a result holds a `date`, `timestamp`, or `timestamptz` later than a JavaScript Date can hold (after September 13, 275760). Those values, and `infinity` and `-infinity` (previously `null`), now come back as the text Postgres returns.
