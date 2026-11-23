---
"neon": minor
---

`neon env pull --role-name <role>` connects `DATABASE_URL` and `DATABASE_URL_UNPOOLED` as `<role>`. Use it on a branch with several roles and no `neondb_owner`, where the role can't be picked automatically; the error on those branches now names the flag.
