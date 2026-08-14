---
"neon": patch
---

`neon init` now detects and installs the `neon` CLI instead of the retired `neonctl` alias. Version probing checks `neon` first (falling back to `neonctl` so an existing global install still counts as installed), the update check reads `npm view neon`, and auth/context lookups shell out to `neon`.
