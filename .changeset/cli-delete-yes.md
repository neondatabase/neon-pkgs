---
"neon": patch
---

Destructive deletes (`projects`, `branches`, `databases`, `roles`, `snapshots`, `bucket`) require `--yes` or a TTY confirmation, and table output prints a Deleted line instead of the same record as `get`.
