---
"@neon/realtime": patch
---

Declare a 128 KiB SQL limit for live-query capabilities, up from 32 KiB, to match the Realtime server once it raises its own limit. The SDK never checked SQL length at runtime: a capability is still refused locally only when its token exceeds 256 KiB, which leaves room for 128 KiB of SQL plus about 45 KiB of parameters. The frozen v1 capability schema is unchanged.
