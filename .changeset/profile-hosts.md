---
"neon": minor
---

Named profiles now remember the `--api-host` and `--oauth-host` they were created or signed in with, so `neon --profile staging <command>` reaches that environment without setting `NEON_API_HOST` on every command. `neon profile list` shows the recorded host.
