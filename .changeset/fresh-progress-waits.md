---
"@neon/realtime": patch
---

Resolve transaction waits from ordered MVCC progress, including transactions that produce no live-query changes. Apply progress only after synchronization and preserve prior visibility evidence when a proof is truncated.
