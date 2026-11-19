---
"neon": patch
---

`neon deploy`, `neon config plan` and `neon config apply` now say when `neon.ts` imports a package that is not installed, and print the install command for the project's package manager, as `neon env pull` already does. They used to print only `Failed to evaluate neon.ts` with a hint that named a syntax error, a missing dependency or a runtime exception.
