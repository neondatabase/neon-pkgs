---
"neon": minor
---

`neon logs query` and `neon logs field-values` accept `--source neon_auth`. `neon logs query` no longer fails a whole page with "Neon returned an invalid logs query response" when a record's `source` is one this release does not list; it prints the record.
