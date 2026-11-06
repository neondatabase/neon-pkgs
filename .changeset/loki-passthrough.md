---
"neon": minor
"neonctl": minor
---

Add `neon logs loki` to issue authenticated LogQL queries and discover labels through the branch's Loki-compatible telemetry API. Bound queries with `--since`, `--start`, `--end`, `--limit`, and `--direction`, or pass string parameters with `-f key=value`. JSON/YAML output preserves Loki's envelope, timestamps, and warnings.
