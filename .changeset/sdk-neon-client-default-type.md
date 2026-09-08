---
"@neon/sdk": patch
---

`NeonClient` now defaults its type parameter to `false`, so `NeonClient` can be used without a type argument to describe the client returned by `createNeonClient({ apiKey })`. `NeonClient<true>` continues to describe a `throwOnError: true` client.
