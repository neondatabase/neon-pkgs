---
"@neon/sdk": patch
"@neon/tools": patch
---

A wait abort or timeout after a mutation keeps the created resource on `error.created`. `createdId(error)` returns the resource id, including nested `project.id` / `branch.id` on createAndConnect. On createAndConnect, `created` is the full 201 body (`connection_uris`, role passwords); read `createdId` rather than logging the error whole.
