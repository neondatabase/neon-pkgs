---
"neon": patch
---

`neon init` now reports "Neon setup complete." when the only service beyond Postgres in the new `neon.ts` is the AI Gateway, since init already pulls its credential and `neon deploy` has nothing left to apply.
