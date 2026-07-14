---
"neonctl": minor
---

`neon config plan` / `apply` (and `deploy`) now render their output as a git-style diff instead of tables. Service changes (Neon Auth, Data API, buckets, functions) list as green `+` additions; branch setting changes (TTL, `protected`, compute) group under a `~ <branch>` header as sorted `field → value` lines. A bare `apply` that hits drift on settings already present remotely now prints those as a sorted before→after diff (`current → desired`, old in red / new in green) — matching the `neon diff` styling — before exiting non-zero with the `--update-existing` hint. Colors honor `--no-color` and non-TTY pipes; `--output json|yaml` is unchanged.
