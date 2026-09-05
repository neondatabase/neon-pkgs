---
"@neon/sdk": major
"@neon/tools": major
---

`neon.branches.create` now returns `{ branch, endpoint?, connectionString? }` instead of a bare `Branch`. The pooled URI is included when the API returns one. `createAndConnect` still requires a URI. The `branches.create` tool returns the same shape.
