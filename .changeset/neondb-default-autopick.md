---
"@neon/env": patch
"neonctl": patch
---

Auto-pick Neon's default `neondb` database when a branch has more than one. Previously `fetchEnv` threw as soon as a branch had multiple databases, so `neonctl link` / `neonctl env pull` failed on a branch that had `neondb` alongside another database. It now uses `neondb` when present (or the sole database otherwise); a branch with several databases and no `neondb` still throws so the choice is never made randomly — rename one to `neondb` or keep a single database (or pass `databaseName` when calling `fetchEnv` directly).
