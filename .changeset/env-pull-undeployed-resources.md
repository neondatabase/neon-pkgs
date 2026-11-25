---
"neon": patch
---

`neon env pull`, `neon link`, and `neon checkout` now write the branch's `DATABASE_URL` and other available variables when `neon.ts` declares a bucket or service the branch does not have yet, and name what `neon deploy` still has to provision. Previously the pull failed, and `link` / `checkout` left the previous branch's values in `.env.local`. Undeployed triggers no longer block `neon env pull` or `neon dev`.
