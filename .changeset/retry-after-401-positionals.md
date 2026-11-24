---
"neon": patch
---

A command with a positional argument, such as `neon branches delete <name>`, no longer fails with `Not enough non-option arguments` when the stored session is refreshed after a 401 and the command is retried. The retry now parses the arguments with a new yargs instance instead of re-parsing the one that already ran.
