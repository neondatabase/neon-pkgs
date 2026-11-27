---
"@neon/auth": patch
---

Fix social account linking for apps that use the route handler without the middleware, and recover when a session verifier fails to redeem.

- A `get-session` request that carries `neon_auth_session_verifier` now skips the session cache and goes upstream with its query string intact, so the server can redeem the verifier and commit the pending link. The cache answered from the existing session before, so the link never completed.
- The browser client now strips the verifier from the page URL when the server definitively rejects it, not only after a successful `get-session`. A rejected verifier left in the URL made every later `get-session` fail, so the app looked signed out. Rejection means a 4xx whose error code says the verifier is unknown, expired, used, or can't be redeemed from this browser (for example `VERIFICATION_NOT_FOUND`, `LINK_SESSION_NOT_FOUND`, `LINK_SESSION_MISMATCH`). Any other failure, such as a 5xx, 408, 425, 429 or a 401/403 without one of those codes, keeps the verifier so a retry can still redeem it.
- When the server rejects the verifier during the middleware exchange, the middleware now redirects to the same URL without it, adding `?error=<code>` unless the URL already has an `error` param. Other failures leave the verifier in place for a retry.
