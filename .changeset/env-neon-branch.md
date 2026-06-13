---
"@neondatabase/env": minor
---

Inject `NEON_BRANCH` (the branch name) alongside the other Neon env vars.

The Neon Functions runtime injects `NEON_BRANCH` into every branch (including the default)
by default, so `fetchEnv` now surfaces the branch on a new optional `branch` namespace and
`toEntries` emits `NEON_BRANCH`. That means `neon dev` / `neon-env run` / `neon env pull`
write `NEON_BRANCH` into local dev too, mirroring the deployed runtime. `parseEnv` reads it
back when present (optional — a missing `NEON_BRANCH` is not an error, so existing
deployments and platform integrations keep working). The value is the branch **name** for now.
