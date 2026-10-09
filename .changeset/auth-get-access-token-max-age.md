---
"@neon/auth": patch
---

Fix the server toolkit's `getAccessToken`, which sent a `GET` to a route Neon Auth serves as `POST`, so the request body was dropped. Also omit the `Max-Age` attribute from forwarded cookies when the upstream value is not numeric instead of emitting `Max-Age=NaN`.
