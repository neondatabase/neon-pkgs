---
"@neon/effect": patch
---

`toNeonEffectError` maps errors thrown by another copy of `@neon/sdk` to their tagged classes instead of rethrowing them as defects, so `@neon/effect` composes with libraries that resolve a different SDK version.
