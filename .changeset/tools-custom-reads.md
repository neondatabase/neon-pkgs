---
"@neon/tools": minor
---

Add custom tools for Neon Auth config, resource search and fetch, SQL (`sql.run`, `sql.runTransaction`, `sql.explain`, schema, branch describe, slow queries, `database.inspect`, migrations, query tuning), neon.com docs, and feedback; `customToolIds` lists them. Execution context gains `readOnly`, `postgresRole`, and `caller`, and `user.organizations` takes an optional `search` filter. Tool and input descriptions are rewritten, and a description that names another tool uses the name it publishes under after `names` and `name`; host `descriptions` can write `{{selector}}` for the same. `postgres.connectionString` no longer fails on an ambiguous database or role; it resolves to neondb or the first database and its owner, like the SQL tools.
