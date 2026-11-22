---
"@neon/realtime-react": patch
---

Isolate rejected async listeners registered through `useLiveQuery().utils`, just as synchronous listener errors are isolated. Listener promises do not delay the React hook or other observers.
