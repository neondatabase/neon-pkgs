---
"@neon/tools": minor
---

`postgres.dataApi.get` (`get_data_api` on the Neon MCP server) returns `{ enabled: false }` for a database without a Data API instead of throwing a 404 `NeonNotFoundError`, and adds `enabled: true` to a configured Data API's result. A missing branch or database still throws. TypeScript callers narrow on `enabled` before reading `url`.
