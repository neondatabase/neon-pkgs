---
"neon": patch
---

`--services` / `--service`, `env pull --env`, and `mcp --category` accept an unquoted comma list from PowerShell, such as `neon init --services postgres,auth`. npm's PowerShell shim passed it to the CLI as one space-separated value, which the CLI rejected as unknown.
