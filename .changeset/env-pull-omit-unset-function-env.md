---
"@neon/config": patch
"neon": patch
"neonctl": patch
---

`neon env pull` (and the pull bundled into `link` / `checkout`) loads neon.ts even when function env vars are unset, so it can still write `NEON_FUNCTION_*_BASE_URL`. `neon dev`, `neon-env run`, and `defineConfig` still reject those missing values.
