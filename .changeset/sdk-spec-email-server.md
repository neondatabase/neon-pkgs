---
"@neon/sdk": patch
"@neon/tools": patch
---

Refresh the vendored OpenAPI spec. Email-server GET responses use a dedicated type that documents password redaction, and `standard` write fields are optional so a Better Auth project can send a partial update.
