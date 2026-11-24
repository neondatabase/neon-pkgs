---
"neon": patch
---

`neon checkout <name> --create` now prints a `WARNING:` line when the branch already exists and is checked out unchanged instead of created; the exit code stays 0. `--help` for `--create` names the parent a new branch starts from: the `parent` in `neon.ts`, else the project's default branch.
