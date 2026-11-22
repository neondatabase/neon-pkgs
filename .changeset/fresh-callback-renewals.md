---
"@neon/realtime": patch
"@neon/realtime-react": patch
---

Restart capability refresh when an integration directly replaces the controller callback. An older automatic refresh can no longer override a newer manual renewal. React keeps a pending request across rerenders of the same query and uses the latest callback for the next request.
