---
"neon": patch
---

Branch-scoped commands now target the branch pinned in `.neon` when they take a `--name` or an id. Before, `neon databases create --name app` in a directory linked to `dev` created the database on the default branch, and `neon triggers get <trigger-id>` failed with `Branch <trigger-id> not found`. Pass `--branch` to target another branch.
