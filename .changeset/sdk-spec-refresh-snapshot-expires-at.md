---
"@neon/sdk": minor
---

Refresh the vendored Neon OpenAPI spec and regenerated client, and surface the new snapshot expiration control ergonomically.

- `snapshots.update(projectId, snapshotId, input)` now accepts `expiresAt` (ISO 8601). Omit it to leave the current expiration unchanged, pass a future timestamp to set an absolute expiration, or pass `null` to clear it so the snapshot never expires — matching the camelCase `expiresAt` already used by `snapshots.create`.
- Regenerated types pick up the renamed `ProjectPermissionLevel` values (`VIEWER` / `EDITOR` / `ADMIN`, previously `CAN_VIEW` / `CAN_EDIT` / `CAN_MANAGE`) to track the live API.
