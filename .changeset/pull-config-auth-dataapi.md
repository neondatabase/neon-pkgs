---
"@neondatabase/config-runtime": minor
---

`pullConfig` now reverse-engineers the branch's **Neon Auth** and **Data API** enablement into the returned `config` (`config.auth = {}` / `config.dataApi = {}` when each integration is enabled on the branch). Previously only branch/postgres settings and the `preview` block (buckets, functions, AI Gateway) were surfaced, so a config pulled from a branch with Auth or Data API enabled did not round-trip through `resolveConfig` / `fetchEnv` — and the matching `NEON_AUTH_BASE_URL` / `NEON_DATA_API_URL` secrets were never injected. Data API is enabled per branch + database, so `pullConfig` probes the branch's default database (`neondb`, else the first database) to detect it.
