---
"neon": patch
"neonctl": patch
---

`neon checkout --env <file>` loads that .env file before applying neon.ts when checkout creates a branch, the same as `neon deploy --env`. Checking out an existing branch ignores `--env`.
