---
"neonctl": minor
---

Add a `snapshots` command group (alias `snapshot`) for managing Neon snapshots from the CLI: `list`, `get`, `create` (from a branch head, timestamp, or LSN, with optional expiration), `update` (rename / set / clear expiration), `delete`, `restore` (to a new branch or onto an existing branch, with optional immediate `--finalize`), `finalize` (commit a previewed restore), and `schedule get` / `schedule set` for a branch's automatic snapshot (backup) schedule.
