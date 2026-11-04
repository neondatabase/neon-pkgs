---
"@neon/sdk": patch
"neon": patch
---

A path parameter of `.` or `..` now fails with a `NeonClientError` before any request is sent, including direct calls such as `client.get({ url, path })` on a client from `createClient`. Previously the URL resolved it as a dot segment, so the request could reach a different API route, such as `branchId: ".."` listing every compute in the project. The CLI applies the same check to the bucket, object, custom domain, Functions, and claimable project paths it builds itself.
