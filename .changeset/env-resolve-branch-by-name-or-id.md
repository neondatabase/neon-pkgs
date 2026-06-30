---
"@neon/env": minor
---

Resolve branches by name or id, not id only. `fetchEnv` now accepts a `branch` option holding either a branch name (e.g. `main`) or an id (`br-…`); the legacy id-only `branchId` option still works. The `neon-env` CLI reads the `branch` field from the flat `.neon` file written by `neonctl link` (falling back to legacy `branchId`), and honors `NEON_BRANCH` in addition to `NEON_BRANCH_ID`. This fixes `neon-env run`/`export` failing to resolve a branch pinned by name.
