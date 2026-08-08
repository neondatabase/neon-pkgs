---
"neon": patch
---

`neon inspect db locks` and `neon inspect db long-running-queries` now report only the database you are inspecting. They previously listed sessions from every database on the branch, and `locks` printed an empty or wrong relation name for those foreign rows. Expect fewer rows than before: to cover a whole branch, run the check once per database.
