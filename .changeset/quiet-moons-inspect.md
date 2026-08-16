---
"neon": minor
---

`neon inspect db` without `--database-name` now runs the check against every database on the branch. `locks` and `long-running-queries` also report only the database you name with the flag; they previously listed sessions from every database, and `locks` printed an empty or wrong relation name for those foreign rows.
