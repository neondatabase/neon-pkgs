---
"neon": minor
---

`neon init` honors `--profile` and `NEON_PROFILE`. `npx neon` subprocesses and agent-emitted commands include `--profile <name>` when a profile was named, and `--config-dir` when you passed it.

