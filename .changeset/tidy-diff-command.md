---
"neonctl": minor
---

Add a top-level `neon diff [compare-branch]` command that prints a git-style schema diff between the branch you're on (pinned in `.neon`, or `--branch`) and another branch. Omitting the argument compares the current branch against its parent ("what did I change since branching?"). Supports `--database`/`--db` to scope to one database (all databases by default), `--output json|yaml` for a structured per-database result, and colorized `git diff`-style output (red `---` / green `+++` / cyan `@@`, honoring `--no-color` and non-TTY pipes). The summary goes to stderr and the diff body to stdout, so `neon diff main > changes.patch` captures just the diff. For history-aware comparisons (a branch against its own past state at a timestamp/LSN), continue to use `branches schema-diff`.
