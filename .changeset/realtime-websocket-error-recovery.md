---
"@neon/realtime": patch
---

Recover from WebSocket errors without recursive close calls or waiting for a close event after a failed connection attempt.

Retry load-shed subscriptions while keeping their last result stale. Honor optional backend overload cooldown hints across reconnections, including the full unsigned 32-bit millisecond range, and preserve transaction confirmation through a fresh baseline.
