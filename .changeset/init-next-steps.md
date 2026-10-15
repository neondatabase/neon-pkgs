---
"neon": patch
---

`neon init` now prints `neon config plan`, `neon deploy`, and the optional branch and agent-skills steps after every new `neon.ts`, including the default Postgres-only one. With `--no-config`, it suggests `neon config init`. The deploy step reads "Deploy to your Neon project:".
