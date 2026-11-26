---
"@neon/realtime": patch
---

Recover live queries from credential changes. After `backend_session_lost`, which a password change causes, the client resubscribes with the envelope it holds (or a fresh one when it has 30 seconds or less left); if that gets `authorization_failed`, it fetches one fresh envelope and retries once, and a second `authorization_failed` reaches the application. After `renewal_failed`, which follows a switch from the Realtime secret to Postgres credentials, it resubscribes once with the renewal's envelope. `QueryRefreshController`, and so `useLiveQuery()`, TanStack DB collections and direct subscriptions, now call `refreshQuery` as soon as a subscription becomes `stale`, at most once per second, instead of waiting for the scheduled refresh.
