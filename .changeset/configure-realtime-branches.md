---
"@neon/config": minor
"@neon/config-runtime": minor
"neon": minor
---

Add Realtime as a branch-level preview feature in `neon.ts`. `neon init --services realtime` and `neon config add realtime [--allowed-origin <origin>]` declare it for plan and deploy, while `neon realtime enable` and `neon realtime disable` manage the selected branch directly.
