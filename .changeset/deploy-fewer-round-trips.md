---
"neon": patch
"@neon/config-runtime": patch
---

`neon deploy` / `neon config apply` make two fewer requests and start their first reads together, so they finish sooner. `neon config plan` and `neon env pull` benefit too. `pushConfig()`, `apply()`, and `plan()` in `@neon/config-runtime` start the project, branch, and endpoint reads together; their results and errors are unchanged.
