---
"@neon/realtime": patch
---

Retry a subscription rejected with `service_unavailable` with backoff, as the Realtime proxy advises, instead of failing it. Realtime returns it while the replica is starting, before its OIDC keys load, or while Postgres logins are throttled.
