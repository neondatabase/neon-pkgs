---
"neon": minor
---

`neon init` honors `--profile` and `NEON_PROFILE`. Agent-emitted `npx neon` and `neon init --agent` commands include the flag when the selection was explicit, so later steps stay on that account.

