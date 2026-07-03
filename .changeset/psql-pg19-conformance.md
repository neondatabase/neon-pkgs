---
"neonctl": minor
---

Bring the embedded `psql` up to PostgreSQL 19 parity. `\d`/`\dRp`/`\dRp+`/`\dRs+` now show the new PG 19 catalog columns — publication "All sequences" (`FOR ALL SEQUENCES`), the publication `EXCEPT` list (a table's "Excluded from publications" and a sequence's "Included in publications" footers), and subscription Server / Retain dead tuples / Max retention duration / Retention active / Receiver timeout. Adds `\pset display_true` / `\pset display_false` to customize how boolean values render. All version-gated, so older servers are unaffected.
