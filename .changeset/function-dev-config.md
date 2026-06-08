---
"@neondatabase/config": minor
---

Add an optional `dev` block to `FunctionConfig` for local development with `neon dev`: `dev?: { port?: number; portless?: boolean }`. It is typed as a discriminated union so `portless: true` requires a concrete `port` (validated at both the type level and by the zod schema). `dev` is passed through untouched onto `ResolvedFunctionConfig` (no defaults applied) and is ignored at deploy time — only `neon dev` reads it (to serve every function declared in `neon.ts` on its configured port, optionally via `portless`).
