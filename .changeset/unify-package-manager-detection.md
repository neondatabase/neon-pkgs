---
"neon": patch
---

Centralize package manager detection for CLI install flows

All install paths now read `src/utils/package_manager.ts` instead of duplicating `npm_config_user_agent` parsing or hardcoded lockfile lists. `bootstrap`, `neon init` getting-started steps, and global `neonctl` installs route through the shared helpers.
