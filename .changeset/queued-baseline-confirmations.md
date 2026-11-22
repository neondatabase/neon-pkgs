---
"@neon/realtime": patch
---

Deliver baseline rows to raw subscriptions before confirming transactions covered by the snapshot. This lets TanStack DB reject pending confirmations when it cannot install the baseline.
