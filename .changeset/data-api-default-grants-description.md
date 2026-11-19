---
"@neon/tools": patch
---

The `add_default_grants` input of `postgres.dataApi.create` now says the grants also cover tables the database owner creates later, that without the flag the Data API can read no table until you grant access, and that `anonymous` is never granted.
