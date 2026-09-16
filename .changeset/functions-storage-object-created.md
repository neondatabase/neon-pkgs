---
"@neon/functions": minor
---

`parseTriggerInvocation` accepts `storage_object_created` deliveries. `TriggerInvocation` is now a union with a top-level `type`; narrow on that (or use the exported type guards) before reading `data`. Hono `parseTrigger` stays schedule-only so `data.scheduledAt` still type-checks.
