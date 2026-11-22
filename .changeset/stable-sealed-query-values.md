---
"@neon/realtime-react": patch
---

Keep one live query subscription across renders that provide equivalent sealed query values. Creating a fresh object with the same values no longer causes repeated subscription restarts.
