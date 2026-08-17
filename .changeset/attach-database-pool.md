---
"@neon/functions": minor
---

Add `attachDatabasePool(pool)` so a module-scope `pg.Pool` does not kill the isolate when Postgres drops an idle client.

Expected idle disconnects are silent. Unexpected idle-client errors go to `console.error`, or to `onUnexpectedError` if you pass one.
