---
"@neon/tools": patch
---

A `Buffer` in a tool result, such as a Postgres `bytea` column from `sql.run`, is serialized the way `JSON.stringify` does (`{ type: "Buffer", data: [...] }`) instead of as an object with numeric keys.
