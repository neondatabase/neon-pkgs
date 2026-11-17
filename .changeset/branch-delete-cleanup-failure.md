---
"@neon/sdk": patch
"@neon/tools": patch
---

`branches.delete` with readiness polling on no longer throws `NeonOperationError` when a cleanup operation fails after the branch is already deleted. It reads the branch back and resolves on 404. Through `@neon/tools`, this also fixes the `delete_branch`, `migrations.complete`, and `queryTuning.complete` tools.
