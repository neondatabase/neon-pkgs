---
"@neon/tools": patch
---

Without `role_name`, the SQL tools and `postgres.connectionString` now reject a `database_name` the Neon API does not list on the branch, such as Neon's reserved `postgres`, with a `NeonClientError` that lists the branch's databases, instead of a bare 404 `database not found`.
