---
"@neon/tools": patch
---

`sql.run`, `sql.runTransaction`, and `sql.explain` no longer fail with `RangeError: Invalid time value` on a `date`, `timestamp`, or `timestamptz` past year 275760, and no longer return `null` for `infinity` or `-infinity`. Those values come back as Postgres's text; every other date is unchanged.
