---
"@neon/tools": minor
---

Add an `outputSchema` to every tool: a Zod object describing its `data`, generated from the OpenAPI success response or written for hand-written tools. `registerNeonTools` (`@neon/tools/mcp` and `@neon/tools/mcp-v1`) now publishes it as the MCP `outputSchema`, `{ data }` around the tool's data schema, matching the `structuredContent` it already returned. Tool ids, input schemas, and `execute()` results are unchanged.

New exports from `@neon/tools`: `toStructuredContent` and `outputDataSchema`, which map between `data` and the object form MCP requires (`{ items }` for an array, `{ value }` for a string or number, `{}` for no body); `withoutCredentials`, `withoutOutputFields`, and `isCredential`, for hosts that strip passwords, connection URIs, and other secrets from results; and the `NeonOutputSchema` type. `@neon/tools/mcp` also exports `toMcpOutputSchema`.
