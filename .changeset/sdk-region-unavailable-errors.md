---
"@neon/sdk": minor
---

Realtime, Neon Functions, function triggers, Object Storage, and AI Gateway calls on a project outside the regions that run them now fail with a `NeonNotFoundError` that names the project's region and the supported regions (`aws-us-east-2`, `aws-us-east-1`, `aws-eu-central-1`, `aws-ap-southeast-1`), followed by the API's original "not available" message.
