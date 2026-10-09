---
"neon": patch
---

`neon connection-string` and `neon inspect db` no longer fail with "Multiple roles found" on a branch with the Data API or Neon Auth enabled. Without `--role-name` they connect as `neondb_owner`, or as the only role besides the Data API and Neon Auth roles, the same role `neon env pull` writes into `DATABASE_URL`.
