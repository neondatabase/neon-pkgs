---
"neon": minor
"neonctl": minor
---

`neon` list and get commands no longer draw box-drawing tables. Default output is space-padded columns that drop and truncate to the terminal width, or stacked `Label  value` lines for a single object. `--output json` and `--output yaml` keep the same fields; `neon profile list` reports OAuth scope as `account` in every format.
