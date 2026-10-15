---
"neon": patch
---

`neon init` now pulls environment variables after writing `neon.ts`, so `.env.local` includes the AI Gateway and Functions variables for the services you selected. The next steps now point to the Neon agent skills, `neon dev` when Functions are selected, `neon checkout dev --create`, `neon config plan`, and `neon deploy`.
