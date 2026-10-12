---
"neon": patch
"@neon/config-runtime": patch
---

Neon Realtime is staging-only for now. Outside `NEON_API_HOST` / `--api-host` pointing at `https://console-stage.neon.build/api/v2`, `neon realtime`, `neon subscribe`, `neon config add realtime`, `--services realtime`, and a `neon.ts` that declares `preview.realtime` fail with "Neon Realtime is coming soon!", and `neon env pull`, `neon config status`, and the env pull in `neon init` / `link` / `checkout` no longer read Realtime. `pullConfig` and `inspect` read Realtime only with `realtime: true`.
