---
"neon": minor
"@neon/config": patch
---

Add `neon claim` and its `claimable` alias for creating, using, claiming, listing, and deleting temporary Claimable Neon projects without an account. `status`, `accept`, and `delete` take an optional project id from `claim list`. `list` prints `state` so an expired assertion is visible without running `status`, and `delete` drops a local record after the identity assertion expires.

Recognize Claimable Neon capability errors in Config-as-Code so unavailable pre-claim services keep their actionable claim guidance instead of being reported as API-key failures.
