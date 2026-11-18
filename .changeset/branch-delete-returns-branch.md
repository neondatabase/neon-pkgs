---
"@neon/sdk": minor
"@neon/tools": minor
---

`branches.delete` now resolves to the deleted `Branch`, or `null` when the project has no branch with that id, instead of `void`. The `branches.delete` tool (`delete_branch` on the Neon MCP server) returns the same value instead of `null` for every call.
