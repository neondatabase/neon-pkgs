---
"@neon/sdk": minor
"@neon/tools": minor
"neon": minor
---

Create read-only and read-write Postgres roles. `neon.postgres.roles.create` and the `postgres.roles.create` tool take `access: "read_only" | "read_write"` with an optional `databaseName` and `schemas`, and `neon roles create` takes `--access`, `--database`, and `--schema`. Without `access`, roles are still created by the Neon API and join `neon_superuser`, as before.
