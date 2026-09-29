---
"neon": patch
---

Nested parent commands such as `neon config add` and `neon snapshots schedule` print their help and exit 0 when run without a subcommand. A missing required argument, an unknown subcommand, or an invalid option value now prints that command's help to stderr above the error.
