---
"neon": minor
---

`neon realtime enable` now waits up to a minute until Realtime is enabled on the branch, prints `Realtime is enabled on branch <id>.`, and exits 1 if the wait times out. Pass `--no-wait` for the previous behavior, which returns right after the request with `Realtime enable requested for branch <id>.`. `neon status` shows Realtime and its allowed origins, and `neon config init --from-branch` declares Realtime in the seeded `neon.ts`.
