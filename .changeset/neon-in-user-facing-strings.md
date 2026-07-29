---
"neon": patch
"@neon/env": patch
"@neon/config": patch
---

Emit `neon` instead of the removed `neonctl` binary name in help text, error hints, and `--agent` command templates, so suggested commands are runnable. When invoked via the `neonctl` compat package the commands still read `neonctl`.
