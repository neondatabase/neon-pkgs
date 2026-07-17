---
"@neon/sdk": minor
---

Refresh the vendored Neon OpenAPI spec and regenerated client to track the live API.

- `PgVersion` now allows major version `19` (max bumped `18` → `19`). Postgres 19 is being rolled out and is only accepted in regions where it has been enabled; requesting it elsewhere returns an error. The type description is updated to reflect GA vs. rollout versions.
- `OperationAction` gains two new values, `tenant_detach_safekeepers` and `tenant_attach_safekeepers`.

No wrapped operations were added or removed (163 operations, coverage unchanged), so the ergonomic `createNeonClient` surface is unaffected — this is a pure type/spec refresh.
