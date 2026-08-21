---
"neon": patch
"neonctl": patch
---

`neon branches list` and `neon snapshots list` show Expires At before Created At so an 80-column terminal keeps the expiry. `neon projects list --recoverable-only` shows Recoverable Until before Deleted At.
