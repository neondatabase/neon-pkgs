---
"@neon/tools": patch
---

`branches.describe` and the branch result of `resources.fetch` no longer list Neon's reserved `postgres` database. The Neon API never lists it, so `sql.run`, `database.inspect`, `queries.listSlow`, and the other SQL tools return 404 for it.
