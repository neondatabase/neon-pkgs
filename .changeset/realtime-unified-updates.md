---
"@neon/realtime": patch
"@neon/realtime-react": patch
"@neon/realtime-tanstack": patch
---

Unify raw query results under `onUpdate()` with `rows` and `changes` events. Complete-row results now remain `live`, `connecting` represents active synchronization, and `stale` is reserved for an expired capability awaiting renewal.
