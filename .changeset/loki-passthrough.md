---
"neon": minor
"neonctl": minor
---

Add `neon logs loki` to run LogQL queries and discover labels through the branch's Loki-compatible read API. Bound queries with `--since`, `--start`, `--end`, `--limit`, and `--direction`, and pick `labels` or `label/<name>/values` with `--endpoint`. JSON/YAML output preserves Loki's envelope, nanosecond timestamps, and warnings.
