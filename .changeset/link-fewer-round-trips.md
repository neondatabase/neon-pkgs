---
"neon": patch
---

`neon link` makes two fewer requests and starts independent reads together, so it finishes sooner. `neon checkout` and `neon env pull` without a `neon.ts` also skip a repeated branch listing, and function URLs are listed alongside the Postgres reads. Output, `.neon`, `.env.local`, prompts, and errors are unchanged.
