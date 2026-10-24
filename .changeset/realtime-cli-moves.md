---
"neon": patch
"neonctl": patch
---

Handle row moves in `neon realtime subscribe` without reporting deletions or
misclassifying later updates. Show moves and their counts separately in the
terminal log, and include each move's destination in raw table output.
