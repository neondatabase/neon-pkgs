---
"@neon/realtime-tanstack": minor
---

Support TanStack DB 1.0 RC and its separate collection status and health
lifecycles. Recoverable Realtime interruptions now appear in
`health.failureReason`, while terminal failures retain ready rows and appear in
`health.error`.
