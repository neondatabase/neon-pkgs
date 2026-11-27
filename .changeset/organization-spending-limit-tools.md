---
"@neon/tools": minor
---

Publish MCP names `get_organization_spending_limit`, `set_organization_spending_limit`, and `disable_organization_spending_limit`. Extend organization spending-limit tools with observed usage and asynchronous enforcement status. New limits default to suspension when rollout is available; omitted enforcement preserves existing limits, including notification-only settings. Explicit false creates notifications only. Add a disable tool using the atomic bodyless POST endpoint to preserve the current amount or null and emails, including concurrent changes or deletion. Disabling requires server support without retries or legacy fallback. Validate integer cents without precision loss and retain monitoring-delay and storage-charge guidance.
