---
"@neon/tools": minor
---

Add custom tools for Neon Auth config, resource search and fetch, SQL (`sql.run`, `sql.runTransaction`, `sql.explain`, schema, branch describe, slow queries, `database.inspect`, migrations, query tuning), neon.com docs, and feedback; `customToolIds` lists them. Execution context gains `readOnly`, `postgresRole`, and `caller`, and `user.organizations` takes an optional `search` filter.
