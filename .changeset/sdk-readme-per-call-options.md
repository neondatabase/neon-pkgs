---
"@neon/sdk": patch
---

Docs: only `throwOnError`, `waitForReadiness`, `requestTimeoutMs`, and `signal` are accepted per call. `retries`, `wait`, `orgId`, `baseUrl`, and `fetch` are client-wide; per-request org selection uses method input (`org_id` / `fromOrgId`).
