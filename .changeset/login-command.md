---
"neon": patch
"@neon/config": patch
"@neon/env": patch
---

`neon login` is the sign-in command, and `neon auth` still works as its alias. Help, errors, and docs now say `neon login`. `neon login --profile <name>` creates a new profile the way `neon auth --profile <name>` did, instead of failing with `Unknown profile`.
