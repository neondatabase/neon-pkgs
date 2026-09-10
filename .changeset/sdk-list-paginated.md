---
"@neon/sdk": major
"@neon/tools": major
---

Every `list` method now returns `Paginated<T>`. `postgres.endpoints.listByBranch` is `list(projectId, { branchId })`. The `listByBranch` tool is gone.
