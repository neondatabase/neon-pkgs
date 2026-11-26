---
"neon": patch
---

`neon init` treats a stored sign-in that has expired and can no longer be refreshed as signed out. `neon init -y` with `--org-id`, `--project-id`, and `--branch` now writes the link offline and `neon.ts`, then names `neon login` as the next step. Previously it failed at the link step without writing the link or `neon.ts`.
