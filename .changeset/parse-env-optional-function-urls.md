---
"@neon/env": patch
---

`parseEnv(config)` and `parseEnv(config, "<slug>")` no longer throw inside a deployed Neon Function when `NEON_FUNCTION_<SLUG>_BASE_URL` is unset, which the runtime does not inject yet. `env.functions` is now optional on those calls. Pass the key, as in `parseEnv(config, ["NEON_FUNCTION_HELLO_BASE_URL"])`, to require it.
