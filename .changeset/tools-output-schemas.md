---
"@neon/tools": minor
---

Every tool has an `outputSchema` describing its `data`, and `registerNeonTools` publishes it as the MCP `outputSchema` of `{ data }`, typed one level deep. The server rejects a successful result that does not match it. `@neon/tools/mcp` exports `toMcpOutputSchema` and `toMcpOutputJsonSchema`.
