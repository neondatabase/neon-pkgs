---
"@neondatabase/config": minor
"@neondatabase/config-runtime": minor
---

Give `neon.ts` config errors a precise, actionable message instead of a misleading catch-all.

A bad function slug used to surface as `preview.functions.<slug>: Invalid key in record`, wrapped in a generic `Failed to evaluate … This is usually a TypeScript syntax error` hint — pointing users at a syntax bug that wasn't there. Two fixes:

- `defineConfig` validation now hoists the real reason out of zod's `invalid_key` issue, so a rejected record key reports *why* (e.g. `preview.functions.hello-world: function slug must be 1-20 lowercase letters and digits (no hyphens or other characters)`).
- `loadConfigFromFile` surfaces a `PlatformError` thrown during evaluation verbatim (the config is invalid, not the TypeScript), reserving the "run it with tsx" hint for genuine syntax/runtime/missing-dependency failures.
- An `undefined` function `env` value (typically a `process.env.X` referenced in `neon.ts` that is unset) used to surface as zod's opaque `preview.functions.hello.env.test: Invalid input: expected string, received undefined`. It now names the function and env key and points at the fix, e.g. `Environment variable "test" for function "hello" is undefined — its value (typically a process.env.*) is unset. Set it (e.g. add it to your .env) or provide a fallback like process.env.X ?? "".` (a non-`undefined` wrong type keeps zod's default message).

Adds `isPlatformError`, a structural guard that recognises a `PlatformError` even across the jiti module-realm boundary (where `instanceof` fails), re-exported from `@neondatabase/config-runtime`.
