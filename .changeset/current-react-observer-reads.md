---
"@neon/realtime-react": patch
---

Read the latest underlying rows and lifecycle state from `useLiveQuery().utils.getSnapshot()` and `getState()`, including inside update and state observers before React processes the snapshot notification.
