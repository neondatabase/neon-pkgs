---
"neon": minor
---

`neon inspect db` without `--database-name` now runs each database-scoped check against every database on the branch and adds a `database` column. Compute-wide checks still run once and keep their previous columns. Pass `--database-name` to keep the previous columns on a database-scoped check. `locks` and `long-running-queries` also report only the database you name with the flag; they previously listed sessions from every database, and `locks` printed an empty or wrong relation name for those foreign rows.
