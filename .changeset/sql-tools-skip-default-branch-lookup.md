---
"@neon/tools": patch
---

SQL tools and `postgres.connectionString` make one fewer Neon API request when `branch_id` is omitted and `database_name` is given with `role_name` or a pinned `postgresRole`.
