---
"neon": patch
---

`neon checkout <name> --create` now says when the branch already exists and is checked out unchanged instead of created. `--help` for `--create` names the parent a new branch starts from: the `parent` in `neon.ts`, else the project's default branch.
