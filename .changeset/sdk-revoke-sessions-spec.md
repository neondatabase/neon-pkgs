---
"@neon/sdk": patch
"@neon/tools": patch
---

Refresh the vendored OpenAPI spec. The Neon Auth email and password config gains `revoke_sessions_on_password_reset`, which revokes all of a user's sessions when their password is reset, and the update email and password config tool accepts it.
