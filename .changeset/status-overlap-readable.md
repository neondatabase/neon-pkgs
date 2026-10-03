---
"neon": patch
"@neon/config-runtime": patch
---

`neon status` / `neon config status` read the branch's state with its independent requests in parallel (about 30% faster), and the table output shows a readable summary plus function, bucket, and credential tables instead of raw JSON. `inspect()` and `pullConfig()` in `@neon/config-runtime` start their reads together; their results and errors are unchanged. JSON, YAML, and `--config-json` output is unchanged.
