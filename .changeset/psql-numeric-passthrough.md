---
"neon": patch
---

Arguments after `--` on `neon psql`, `neon connection-string --psql`, `neon branches create --psql`, and `neon projects create --psql` now reach psql exactly as typed. Numeric-looking values were rewritten (`1e3` became `1000`), and the embedded psql crashed on them.
