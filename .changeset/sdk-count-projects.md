---
"@neon/sdk": minor
"@neon/tools": minor
---

Add `countProjects` (`GET /projects/count`, beta) from the live Neon API spec: it returns `{ count }` for the active projects in an organization without paging through them. It is in `@neon/sdk/raw`, and `@neon/tools/schemas` exports its `zCountProjectsQuery` schema. The consumption history metric docs now list the Neon Functions metrics (`functions_active_capacity_microseconds`, `functions_waiting_capacity_microseconds`, `functions_invocations`, `functions_egress_bytes`).
