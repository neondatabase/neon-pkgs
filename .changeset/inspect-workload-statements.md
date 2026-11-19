---
"@neon/tools": patch
"neon": patch
---

`database.inspect` `outliers` and `calls`, `queries.listSlow`, and `neon inspect db outliers` and `calls` leave out the statements Neon runs on its own (compute setup as `cloud_admin`, and the session reset after each HTTP query) and the diagnostics' own SQL, so the rankings and the `prop_exec_time` shares cover your workload.
