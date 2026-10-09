---
"neon": patch
"@neon/config": patch
---

When Neon Auth can't be provisioned on a branch (for example because the database already has a `neon_auth` schema), `neon neon-auth enable` now shows the API's reason instead of "Neon Auth is not enabled for this branch", and `neon deploy` / `neon config apply` no longer append a hint about name collisions.
