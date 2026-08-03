---
"neon": patch
"neonctl": patch
---

Make `profiles` the primary spelling of the profile command group

`profile` was primary with `profiles` as the alias, which is backwards from every other group — `projects`/`project`, `branches`/`branch`, `databases`/`database`. Both spellings continue to work.

The group first appears in an unreleased version, so nothing depends on the old ordering.
