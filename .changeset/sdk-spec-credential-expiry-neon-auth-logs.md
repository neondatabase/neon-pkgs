---
"@neon/sdk": minor
---

Refresh the vendored Neon OpenAPI spec. `credentials.create` accepts `expires_at`, 1 minute to 365 days from now; omit it for a credential that never expires. Rotating a credential keeps its expiry, and an expired credential can't be rotated. `ProjectBranchLogSource` adds `neon_auth`, so `logs.query` and `logs.fieldValues` can filter on Neon Auth records; with `source: "neon_auth"` they answer `404` `telemetry_not_enabled` while the project's Neon Auth logs are not enabled.
