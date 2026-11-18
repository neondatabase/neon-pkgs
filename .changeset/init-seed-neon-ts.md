---
"neon": minor
---

`neon init` now writes `neon.ts` from the branch's current services when it links an existing project, as `neon config init --from-branch` does, so `neon env pull` returns those services' variables (Neon Auth, Data API, Object Storage, Realtime). New projects still get the starter policy, `--services` still picks the services, and `--no-config` still skips `neon.ts`.
