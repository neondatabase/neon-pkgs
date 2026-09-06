---
"@neon/sdk": patch
"@neon/tools": patch
---

A wait abort or timeout after a mutation keeps the created resource on `error.created`. `createdId(error)` returns the resource id, including nested `project.id` / `branch.id` on createAndConnect.
