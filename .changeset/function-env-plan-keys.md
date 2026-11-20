---
"@neon/config-runtime": minor
"neon": patch
---

`neon config plan` and `neon deploy` list the env keys each function deploy sets and unsets under its `function <slug>` line, so a declared variable that `neon.ts` read as unset is visible before it is removed. `pushConfig` reports the same key names as `envSet` and `envUnset` in the `details` of each `function:<slug>` change.
