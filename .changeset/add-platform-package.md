---
"@neondatabase/platform": minor
---

Add `@neondatabase/platform` — IaC and Config-as-Code for the Neon Platform.

Define your Neon project, branch blueprints, TTLs, and compute settings in a single `neon.ts` at the root of your repo, then sync them with `pullConfig` / `pushConfig`. The package is intended to back a future `neonctl platform pull|push|branch` command and can also be used directly as a TypeScript SDK.

Highlights:

- Standalone `neon-platform` CLI binary (`neon-platform pull|push|context`) that wraps the SDK. Lets the same commands be exercised in isolation while neonctl integration is in flight; structured exit codes for each failure mode and env-var fallbacks (`NEON_API_KEY`, `NEON_PROJECT_ID`, `NEON_ORG_ID`, `NEON_BRANCH_ID`).
- Support for both **organisation/user-scoped** and **project-scoped** Neon API keys. Project-scoped keys must supply a `projectId` (via option / env / `.neon/project.json`); attempting to push without one returns `PLATFORM_INSUFFICIENT_SCOPE` instead of a raw HTTP 403.
- Built-in retry on HTTP 423 (Locked) for all mutating calls in the real Neon adapter, with exponential backoff up to ~30s total. Neon returns 423 while a previous mutation on the same resource is still in flight; the SDK now waits for it to drain instead of surfacing a transient error to the caller.
- Comprehensive typed error surface: every package-thrown error extends `PlatformError` with a stable `code` (exported via `ErrorCode`) and structured `details` (status, request id, neon API message, operation label). Raw `AxiosError`s from the Neon API are wrapped with clear, actionable messages — e.g. an expired key now says "API key is unauthorized … Generate or rotate your key at <link>" instead of "Request failed with status code 401". CLI maps each code to a distinct exit code (6 unauthorized, 7 forbidden/scope, 8 not found, 9 rate-limited, 10 network, 11 server/locked, 99 internal-bug) and a new `--debug` flag prints stack + structured details on failure.
- On first-time project create, push now passes the root blueprint's pattern as the project's default branch name so the auto-created default branch matches the desired config immediately (no `updateExisting` required on the first push).
- Standalone end-to-end test suite (`pnpm test:e2e`) that creates / mutates / deletes real Neon projects against an org-scoped key supplied via `.env`. Skipped from `test:ci`; gated behind `NEON_API_KEY`.
- `defineConfig(input)` — strict, zod-backed config validation that aggregates every issue into a single `ConfigValidationError`. The underlying `configSchema` / `projectConfigSchema` / `branchBlueprintSchema` / `computeSettingsSchema` are exported for direct use too.
- `pullConfig(options?)` — read the live Neon project state into a `Config` object (filesystem read-only; never writes a `.neon` file).
- `pushConfig(...)` — three overloads: `pushConfig()` auto-loads `neon.ts` and fails on conflict; `pushConfig(options)` toggles `applyChanges` / `updateExisting` / `applyExisting`; `pushConfig(config, options?)` operates on an already-validated `Config`.
- `loadContext(options?)` — resolves project + branch context with a 3-step chain: call args → env vars (`NEON_BRANCH_ID`, `NEON_PROJECT_ID`, `NEON_ORG_ID`) → `.neon/project.json` (preferred) or `.neon` (interop with `neonctl set-context`).
- Wildcard branch blueprints (e.g. `preview: { pattern: "preview-*" }`) gate apply-to-existing behind `applyExisting: true`; specific-name blueprints (e.g. `production`) always create-if-missing and gate updates behind `updateExisting: true`.
- Public `NeonApi` interface plus a real adapter over `@neondatabase/api-client` so callers can inject a fake for integration tests.
