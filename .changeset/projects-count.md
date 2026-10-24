---
"@neon/sdk": minor
"@neon/tools": minor
"@neon/effect": minor
---

Add `neon.projects.count()`, which returns the number of active projects in the organization without paging through `projects.list()` (`GET /projects/count`, beta). It takes `{ org_id? }` and defaults to the client's `orgId`. `@neon/tools` publishes it as the `projects.count` selector (`count_projects`), and `@neon/effect` exposes it as an `Effect<number>`.
