---
"@neon/sdk": patch
"@neon/tools": patch
---

With `waitForReadiness`, `postgres.endpoints.create`, `update`, `start`, `suspend`, and `restart` now return the endpoint read after their operations finish, so `current_state`, `pending_state`, and `started_at` match a later `get`. The `create_postgres_endpoint`, `update_postgres_endpoint`, `start_postgres_endpoint`, `suspend_postgres_endpoint`, and `restart_postgres_endpoint` tools return that endpoint too.
