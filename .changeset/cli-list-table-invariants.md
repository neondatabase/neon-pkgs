---
"neon": patch
"neonctl": patch
---

List commands print every populated column at full width on one line per row. A narrow terminal wraps the line instead of dropping or truncating columns. `neon branches list` and `neon snapshots list` show Expires At before Created At, including on get and create. `neon projects list --recoverable-only` shows Recoverable Until before Deleted At.
