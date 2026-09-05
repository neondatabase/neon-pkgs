---
"@neon/sdk": major
"@neon/tools": major
---

`neon.branches.create` now returns `{ branch, endpoints?, endpoint?, connectionUris?, connectionString? }` instead of a bare `Branch`. `createAndConnect` still requires a URI. The `branches.create` tool returns the same shape.
