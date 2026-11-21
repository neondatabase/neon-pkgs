---
"@neon/config": patch
"@neon/config-runtime": patch
"neon": patch
---

Deploying a Function from `neon.ts` now sets the display name declared in `functions.<slug>.name`, and resets a name changed elsewhere back to it. Before, the deployed Function kept its slug as its name. A name made only of whitespace is now rejected when `neon.ts` loads, since the Functions API refuses it.
