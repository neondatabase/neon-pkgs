---
"neon": minor
"@neon/env": minor
---

`neon.ts` and the default `.env` / `.env.local` are now read only from the project directory: the directory holding the nearest `.neon`, or the current directory when there is none. A `neon.ts` in a parent directory no longer applies; pass `--config <path>` to use one. `neon init` always sets up the current directory (its own `.neon`, `neon.ts`, and `package.json`), so a parent's `.neon`, `neon.ts`, or `package.json` never affects it.
