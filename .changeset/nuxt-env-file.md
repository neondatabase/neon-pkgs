---
"neon": patch
---

`neon link`, `neon checkout`, `neon env pull`, and `neon claim create` now write a Nuxt app's Neon variables to `.env`, the file Nuxt loads by default, when the project has neither `.env` nor `.env.local`.
