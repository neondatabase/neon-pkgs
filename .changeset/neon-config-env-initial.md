---
"@neondatabase/config": minor
"@neondatabase/env": minor
---

Initial release of `@neondatabase/config` and `@neondatabase/env` — Config-as-Code for the Neon Platform.

`@neondatabase/config` lets you define your Neon project, branches, TTLs, and compute settings in a single `neon.ts` policy and inspect/diff/deploy it against the Neon API as plain TypeScript functions:

- `defineConfig(input)` — strict, zod-backed config validation that aggregates every issue into a single error.
- `pullConfig(options?)` — read the live Neon project state into a `Config` object.
- `pushConfig(...)` — diff and apply your policy to the Neon API, with `applyChanges` / `updateExisting` / `applyExisting` controls.
- Support for both organisation/user-scoped and project-scoped Neon API keys, built-in retry on HTTP 423 (Locked) for mutating calls, and a fully typed, actionable error surface (every error carries a stable `code` and structured `details`).

`@neondatabase/env` resolves and injects Neon connection strings for the branch selected by your `neon.ts` policy:

- `fetchEnv` / `parseEnv` — return a fixed, statically-typed, namespaced env shape (e.g. `env.postgres.databaseUrl`).
- A single `neon-env run -- <cmd>` CLI to run any command with the resolved Neon connection strings injected into its environment.
