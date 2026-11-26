---
"@neon/auth": patch
---

`token()` now requests a fresh JWT from `/token` and resolves to `{ token }`. Before, after a `getSession()` call it resolved to the cached session (`{ session, user }`), so `data.token` was `undefined`.
