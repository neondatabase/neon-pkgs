---
"@neon/tools": minor
---

Published tool ids are now the last SDK-path segment, then the resource, in snake_case (`projects.list` → `list_projects`, `postgres.connectionString` → `connection_string_postgres`). Hosts that need a historical name still pass `names`.
