---
"neon": minor
---

`neon init` honors `--profile` and `NEON_PROFILE`. `npx neon` subprocesses and agent-emitted `neon init --agent` commands include `--profile <name>` when a profile was named by `--profile` or `NEON_PROFILE`; nothing is added when neither is set.

