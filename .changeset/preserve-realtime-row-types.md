---
"@neon/realtime": patch
---

Preserve sealed queries' live row types through JSON-aware RPC typing. Serialized initial data must be converted to the live row representation before being passed to the SDK; for example, restore JSON date strings to `Date` objects when the live parser returns `Date`.
