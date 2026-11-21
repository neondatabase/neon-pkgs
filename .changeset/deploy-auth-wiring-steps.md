---
"neon": patch
---

`neon deploy` and `neon config apply` now warn when `neon.ts` declares Neon Auth but the Next.js app next to it doesn't depend on a Neon Auth SDK such as `@neon/auth`. The warning lists the steps that wire Auth into the app and ends with checking that `GET /api/auth/get-session` returns JSON.
