---
"@neon/tools": patch
---

`schema.describeTable` now lists every constraint for a role with only SELECT on the table, and includes `EXCLUDE` constraints. Mixed-case names such as `User`, `public.User`, and `Auth.User`, as `schema.listTables` returns them, now resolve; a name that could mean two tables, such as `User` when both `"User"` and `user` exist, fails and names both instead of describing one.
