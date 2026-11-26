---
"neon": patch
"@neon/env": patch
---

A directory with its own `package.json` and `neon.ts` is now its own project: the search for `.neon` stops there instead of reaching a linked parent folder. `neon link` run inside such an app links the app and pulls env vars into it instead of relinking the parent, and `neon-env run` no longer uses the parent's project for it. An app that relied on the parent's link needs `neon link` run in it once.
