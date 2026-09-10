---
"@neon/sdk": minor
"@neon/tools": minor
"neon": minor
---

Add two capabilities from the latest Neon OpenAPI spec, across the SDK, MCP tools, and CLI:

- Credential reveal and rotate: `neon.credentials.reveal()` / `rotate()` in the SDK and a published `rotate` MCP tool, with `reveal` hidden like `roles.password`. Not added to the CLI yet.
- Function triggers: a `neon.triggers` resource (`list`, `get`, `create`, `update`, `delete`) with matching MCP tools, plus a `neon triggers` CLI command group that adds `enable` and `disable`.

The spec refresh also drops the removed `hard_delete` branch-delete option.
