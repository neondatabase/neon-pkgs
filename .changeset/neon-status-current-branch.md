---
"neonctl": minor
---

Add `neon status` and the `--current-branch` flag for `config status`.

`neon status` is a top-level alias for `neon config status` (it mirrors all of its options and delegates to the same handler).

`config status --current-branch` (also `neon status --current-branch`) prints only the branch pinned in the local `.neon` file with no network request, no login, and no analytics — cheap enough to drive a shell prompt (e.g. starship). It prints the branch name to stdout and exits 0; when no branch is pinned it prints nothing to stdout, writes a `neonctl checkout <branch>` hint to stderr, and exits non-zero (grep-style) so a prompt can guard on the command directly.
