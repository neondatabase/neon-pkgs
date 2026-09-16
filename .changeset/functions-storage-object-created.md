---
"@neon/functions": minor
---

Add `parseTriggerDelivery` for `storage_object_created` Function Trigger deliveries. `TriggerInvocation`, `parseTriggerInvocation`, and Hono `parseTrigger` stay schedule-only, so existing `data.scheduledAt` callers keep compiling.
