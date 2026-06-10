---
"@neondatabase/env": patch
---

Default `fetchEnv` to the `neondb_owner` role when a branch has several roles.

Enabling Neon Auth / the Data API provisions the PostgREST roles
(`authenticator`, `anonymous`, `authenticated`) alongside the project owner, so `env pull`
saw multiple roles and refused to auto-pick the connection role. `fetchEnv` now defaults to
Neon's owner role (`neondb_owner`) — or, for projects created with a custom owner name, the
single role left after dropping those managed Auth/Data API roles — and only asks for an
explicit `roleName` when more than one app role genuinely remains.
