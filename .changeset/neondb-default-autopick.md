---
"@neon/env": minor
"neonctl": patch
---

Auto-pick the branch database instead of failing when a branch has more than one. `fetchEnv` now prefers Neon's default `neondb`; if that is absent it uses the sole database, or — among several — one owned by the connecting role (alphabetically first), else the alphabetically-first database. A new optional `onNotice` callback reports which database was chosen when there is more than one.

For the CLI this means `neonctl link` / `neonctl env pull` now pull env for the default `neondb` (or a deterministically chosen database) on multi-database branches — printing an info line naming the choice — instead of erroring with "cannot auto-pick".
