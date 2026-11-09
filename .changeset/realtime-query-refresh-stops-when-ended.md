---
"@neon/realtime": patch
---

`QueryRefreshController` stops refreshing once its subscription is in `error` or `closed`. A failed subscription rejects every renewal, and the controller used to retry about once a second, calling `refreshQuery` (usually the app's seal endpoint) each time. `useLiveQuery` in `@neon/realtime-react` uses this controller, so it stops too.
