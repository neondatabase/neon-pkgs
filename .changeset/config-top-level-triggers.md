---
"@neon/config": minor
"@neon/config-runtime": minor
"neon": minor
---

Declare Function triggers as a top-level keyed map in neon.ts. Nested `functions.*.triggers` is removed. `storage_object_created` is supported alongside `schedule`. `neon triggers create --bucket` creates a storage trigger.
