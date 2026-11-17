---
"@neon/realtime-tanstack": patch
---

Apply each Realtime update as a whole when checking collection keys. Ordered refreshes and ordinary ticks can exchange content keys between row IDs; reject only keys that still have two owners after the update.
