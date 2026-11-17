---
"@neon/sdk": patch
"@neon/tools": patch
---

`branches.delete` no longer fails for a branch that was deleted. Neon removes the branch when it accepts the delete, and the operations the response returns clean up afterwards. With readiness polling on, a failed cleanup operation used to fail the call with `NeonOperationError`, even though the branch was gone and deleting it again is rejected. Now the call reads the branch back and resolves when that returns 404; other cleanup may still be running. When the read-back returns the branch or fails, the operation error stands (`NeonAbortError` if the call was aborted).

The `@neon/tools` client polls on every call, so `branches.delete` and `queryTuning.complete` no longer fail, and `migrations.complete` no longer returns `cleanupError`, for a branch that was deleted.
