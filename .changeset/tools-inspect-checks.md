---
"@neon/tools": patch
---

Export `inspectChecks`, the `database.inspect` check catalog with each check's scope, required extension, fields, and empty-result note. Restore description facts the 2.13.0 rewrite dropped, such as when `postgres.connectionString` fails and how `auth.oauthServer.update` treats `mcp`.
