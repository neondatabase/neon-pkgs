---
"neon": patch
"neonctl": patch
"@neon/config": patch
---

`neon deploy --help` and `neon functions deploy --help` now say which command is the neon.ts full deploy and which is the manual/targeted path, and that `neon deploy --env` is a .env file. An unset Function env value in neon.ts tells you to set it or omit the key, not to coerce with `?? ""`.
