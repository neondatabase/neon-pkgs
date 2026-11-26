---
"neon": patch
---

`neon skills`, `neon plugins`, and the agent setup in `neon init` now work when the CLI is started with `npx --package=neon …` or `npm exec -c '…'`, instead of failing because the nested `npx` call inherited the parent command's package or command.
