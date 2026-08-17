---
"@neon/sdk": minor
"@neon/tools": minor
---

Email-server GET responses now use `StandardEmailServerResponse` / `NeonAuthEmailServerConfigResponse`. `StandardEmailServer` is the write shape and its fields are optional, so a Better Auth project can send a partial update. A Stack Auth project still needs all six fields or the API returns 400. Code that read `host` (or the other five fields) off `StandardEmailServer` should switch the annotation to `StandardEmailServerResponse`.
