---
"@neon/functions": minor
---

`parseTriggerInvocation` accepts `storage_object_created` deliveries. `TriggerInvocation` is now a union; narrow on `trigger.type` before reading `data`.
