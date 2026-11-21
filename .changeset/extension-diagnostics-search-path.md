---
"@neon/tools": patch
---

`queries.listSlow` and the `database.inspect` checks that need `pg_stat_statements` or `neon` now work when the extension is installed in a schema that is not on the role's `search_path`, instead of failing because Postgres cannot find the extension's view or functions. When the extension is missing, `queries.listSlow` now returns the same guidance as `database.inspect`: ask the user before running `CREATE EXTENSION IF NOT EXISTS <extension>;`.
