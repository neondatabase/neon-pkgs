---
"neon": patch
"@neon/config-runtime": patch
---

`neon status` / `neon config status` start the project, branch, endpoint, and database reads together, so they return faster, and the table output shows a readable summary plus function, bucket, and credential tables instead of raw JSON. `inspect()` and `pullConfig()` in `@neon/config-runtime` start those reads together; their results and errors are unchanged. JSON, YAML, and `--config-json` output is unchanged.
