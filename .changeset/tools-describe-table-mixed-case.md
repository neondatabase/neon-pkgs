---
"@neon/tools": patch
---

`schema.describeTable` finds tables whose names have upper case letters, such as Prisma's `User`, when given the raw name `schema.listTables` returns (`User`, `public.User`, `Auth.User`). Quoted SQL names like `"Auth"."User"` and lowercase names work as before. A name that matches two tables now fails with the quoted names to pass instead of describing one of them. `queryTuning.prepare` gets the same fix for mixed case tables in a plan.
