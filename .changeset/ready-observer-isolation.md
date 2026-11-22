---
"@neon/realtime-tanstack": patch
---

Keep a Realtime collection syncing when a synchronous TanStack readiness observer throws after the first snapshot has been installed. The exception is reported as a subscription listener failure.
