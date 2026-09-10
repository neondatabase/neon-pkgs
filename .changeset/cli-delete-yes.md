---
"neon": minor
---

Destructive deletes (`projects`, `branches`, `databases`, `roles`, `snapshots`, `bucket`) require `--yes` or a TTY confirmation. Scripts and CI that omit `--yes` now exit 1. Table output prints a Deleted line instead of the same record as `get`.
