---
"@neon/tools": minor
---

`credentials.create` takes `expires_at` and sends it to the API; omit it for a credential that never expires. `logs.query` and `logs.fieldValues` accept `source: "neon_auth"`, and their `source` input says it answers `404` `telemetry_not_enabled` while the project's Neon Auth logs are not enabled. `toMcpInputSchema`, and so `registerNeonTools`, now publish `pattern: "Z$"` instead of Zod's 256-character ISO date-time pattern next to `format: "date-time"`, so MCP `tools/list` input schemas change for every date-time input. The server still validates the full date-time format.
