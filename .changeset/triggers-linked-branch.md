---
"neon": patch
---

`neon triggers get|update|enable|disable|delete <trigger-id>` without `--branch` now target the branch pinned in `.neon`, or the project's default branch. They used to fail with `Branch <trigger-id> not found`.
