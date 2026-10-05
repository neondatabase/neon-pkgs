---
"neon": patch
---

`neon link` makes two fewer requests and starts independent reads together, so it finishes sooner. Its summary now shows the project name, relative paths, and the pulled env vars grouped by service, with new credential values marked `*`. `neon checkout` and `neon env pull` without a `neon.ts` also skip a repeated branch listing.
