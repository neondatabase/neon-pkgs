---
"@neondatabase/env": minor
---

Add an optional key filter to `parseEnv` for requiring + returning only a subset of env vars.

`parseEnv(config, keys)` now accepts an array of OS-level env-var keys (e.g.
`["DATABASE_URL", "NEON_AUTH_BASE_URL"]`) as an alternative to the function-slug scope. In
this mode only the selected vars are enforced and returned, projected into a **narrowed**
`NeonEnv` shape — so a Next.js app that reads `DATABASE_URL` but not `DATABASE_URL_UNPOOLED`
no longer throws over vars it never uses. The keys are typesafe against the policy
(`SelectableEnvKey<Config>`): selecting a var from a namespace the policy doesn't enable is a
compile error, and the result type drops both unselected namespaces and unselected properties
within a kept namespace.
