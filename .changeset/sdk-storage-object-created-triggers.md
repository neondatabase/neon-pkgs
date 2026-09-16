---
"@neon/sdk": minor
---

`neon.triggers` accepts `storage_object_created` alongside `schedule`. `create`/`update` keep the request `type` on the return type. `list`/`get` return the `Trigger` union — narrow before reading kind-specific fields. The generated schedule trigger type no longer includes `source_branch_id`.
