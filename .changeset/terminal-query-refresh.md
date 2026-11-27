---
"@neon/realtime": patch
"@neon/realtime-tanstack": patch
---

Add an optional `isTerminalRefreshError` predicate so applications can stop retrying permanent errors from `refreshQuery`. TanStack collections report those failures through collection health. Refresh failures still retry by default.
