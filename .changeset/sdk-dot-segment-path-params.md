---
"@neon/sdk": patch
"neon": patch
---

A path parameter of `.` or `..` now fails with a `NeonClientError` before any request is sent. Previously the URL resolved it as a dot segment, so the request could reach a different API route, such as `branchId: ".."` listing every compute in the project.
