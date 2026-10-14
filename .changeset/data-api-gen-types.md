---
"neon": minor
---

Add `neon data-api gen-types`, which generates TypeScript types from a database schema. It replaces `neon-js gen-types`: `--db-url` is now optional (the CLI resolves the project, branch, role and database like `connection-string`), the output file is `--out-file` instead of `--output`, and `--query-timeout` is now applied.
