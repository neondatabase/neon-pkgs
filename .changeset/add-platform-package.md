---
"@neondatabase/platform": minor
---

Add `@neondatabase/platform` — IaC and Config-as-Code for the Neon Platform.

Define your Neon project, branch blueprints, TTLs, and compute settings in a single `neon.ts` at the root of your repo, then sync them with `pullConfig` / `pushConfig`. The package is intended to back a future `neonctl platform pull|push|branch` command and can also be used directly as a TypeScript SDK.

Highlights:

- Standalone `neon-platform` CLI binary (`neon-platform pull|push|context`) that wraps the SDK. Lets the same commands be exercised in isolation while neonctl integration is in flight; structured exit codes for each failure mode and env-var fallbacks (`NEON_API_KEY`, `NEON_PROJECT_ID`, `NEON_ORG_ID`, `NEON_BRANCH_ID`).
- `defineConfig(input)` — strict, zod-backed config validation that aggregates every issue into a single `ConfigValidationError`. The underlying `configSchema` / `projectConfigSchema` / `branchBlueprintSchema` / `computeSettingsSchema` are exported for direct use too.
- `pullConfig(options?)` — read the live Neon project state into a `Config` object (filesystem read-only; never writes a `.neon` file).
- `pushConfig(...)` — three overloads: `pushConfig()` auto-loads `neon.ts` and fails on conflict; `pushConfig(options)` toggles `applyChanges` / `updateExisting` / `applyExisting`; `pushConfig(config, options?)` operates on an already-validated `Config`.
- `loadContext(options?)` — resolves project + branch context with a 3-step chain: call args → env vars (`NEON_BRANCH_ID`, `NEON_PROJECT_ID`, `NEON_ORG_ID`) → `.neon/project.json` (preferred) or `.neon` (interop with `neonctl set-context`).
- Wildcard branch blueprints (e.g. `preview: { pattern: "preview-*" }`) gate apply-to-existing behind `applyExisting: true`; specific-name blueprints (e.g. `production`) always create-if-missing and gate updates behind `updateExisting: true`.
- Public `NeonApi` interface plus a real adapter over `@neondatabase/api-client` so callers can inject a fake for integration tests.
