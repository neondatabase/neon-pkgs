---
"neon": minor
"@neon/config-runtime": minor
---

Neon Realtime works against the production API. `neon realtime` (including `neon realtime subscribe`), `neon config add realtime`, `--services realtime`, and `preview.realtime` in `neon.ts` no longer require `NEON_API_HOST` to point at staging, and `neon env pull`, `neon config status`, and `neon dev` read the branch's Realtime state again. `pullConfig` and `inspect` read Realtime by default; pass `realtime: false` to skip it.
