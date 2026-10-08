---
"@neon/config-runtime": minor
"@neon/config": patch
---

`apply()` accepts `confirm` and `beforeMutations`, and the `confirm` context carries `overrides`: the settings that would be overridden, as current → desired. `beforeMutations` runs once after confirmation and before the first change. `PushAbortedError` names the `--allow-protected` flag.
