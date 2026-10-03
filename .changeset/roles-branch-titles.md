---
"neon": patch
---

`neon roles list`, `create`, and `delete` name the branch in their table output (for example `Roles on main`), and an empty list prints `No roles on <branch>.`. `neon roles create` now shows the generated password in table output too; the API returns it only once. JSON and YAML output is unchanged.
