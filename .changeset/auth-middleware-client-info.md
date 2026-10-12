---
"@neon/auth": patch
---

Send the `X-Neon-Client-Info` header on the middleware's get-session lookup and OAuth verifier exchange, so Neon Auth attributes that traffic to `@neon/auth` instead of an unknown SDK. An inbound `X-Neon-Client-Info` value is preserved.
