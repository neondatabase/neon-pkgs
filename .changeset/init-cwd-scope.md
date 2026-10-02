---
"neon": patch
---

`neon init` keeps setup inside the current directory: it no longer evaluates a `neon.ts` from a parent directory while pulling env vars, and `neon init` / `neon config init` create a `package.json` before installing so `@neon/config` and `@neon/env` never land in a parent project's `package.json`.
