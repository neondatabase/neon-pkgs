---
"@neon/sdk": patch
"@neon/effect": patch
"@neon/tools": patch
"neon": patch
---

When a mutation waits for its operations and one ends `failed`, `error`, or `cancelled`, the error now names the project the operation ran on, plus its branch and compute when it has them. It also says the change may be partly applied, and says to wait for the project's other operations to finish and check the current state before retrying.
