---
"@neon/sdk": minor
---

`createNeonClient` now throws a `"client"`-kind error when `apiKey` is missing or `""`, instead of sending an unauthenticated request and surfacing a 401 on the first call. A function that later returns empty is still accepted at construction.
