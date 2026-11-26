---
"neon": patch
---

An unknown command now gets a suggestion under the error. A misspelling names the nearest command (`neon projcts` → "Did you mean `neon projects`?", `neon projects lst` → "Did you mean `neon projects list`?"). Six names that are not misspellings get a pointer of their own: `whoami` (`neon me`), `keys` (`neon api-keys`), `sql` (`neon psql`), `storage` (`neon buckets`), `regions` (the region IDs in `neon projects create --help`) and `functions logs` (`neon logs query --source function`). The help text and the `Unknown command` error line are unchanged.
