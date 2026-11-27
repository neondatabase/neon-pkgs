---
"@neon/realtime-react": patch
---

Notify `utils.onChange()` listeners only when the underlying subscription publishes a snapshot. Hook-local refresh errors and renewal acknowledgements do not republish unchanged rows.
