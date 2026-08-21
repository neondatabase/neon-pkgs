---
"neon": patch
"neonctl": patch
---

`neon branches list` and `neon snapshots list` show Expires At before Created At, including on get and create. `neon projects list --recoverable-only` shows Recoverable Until before Deleted At.
