---
"neon": patch
---

Writing the `.neon` context file via `link`, `checkout`, or `set-context` now preserves fields the command doesn't own instead of overwriting the whole file. Managed keys (`orgId`, `projectId`, `branch`, `branchId`) are still governed by the write, but foreign keys, most importantly the ephemeral `_init` state `neon init` stashes, are carried forward. `neon link --clear` still resets the file wholesale.
