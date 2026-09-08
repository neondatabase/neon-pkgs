---
"@neon/sdk": patch
---

Docs: `CallOptions` is `throwOnError`, `waitForReadiness`, `requestTimeoutMs`, `wait`, and `signal`. `retries`, `orgId`, `baseUrl`, and `fetch` are client-wide; per-request org selection uses method input (`org_id` / `fromOrgId`).
