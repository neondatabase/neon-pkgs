---
"neon-init": patch
---

Support NEON_API_HOST env var for targeting staging environments. When set, all neonctl commands (including agent-issued ones) include --api-host and --oauth-host flags.
