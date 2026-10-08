---
"neon": patch
---

`neon snapshots restore` and `update` skip the snapshot listing when given a snapshot id, and `create` and `schedule get` / `set` skip the branch listing when given a branch id: one request fewer each.
