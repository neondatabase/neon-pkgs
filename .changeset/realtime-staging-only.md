---
"neon": patch
"@neon/config-runtime": patch
---

Realtime is staging-only for now. `neon realtime` and `neon subscribe` exist only when `NEON_API_HOST` or `--api-host` points at `https://console-stage.neon.build/api/v2`, and `neon env pull`, `neon config status`, and the env pull in `neon init` / `link` / `checkout` no longer read Realtime against production, where the endpoint fails. `pullConfig` and `inspect` read Realtime only with `realtime: true`.
