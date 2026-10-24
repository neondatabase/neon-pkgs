---
"@neon/tools": patch
---

Security patch: keep OAuth client secrets out of model-facing provider tools. This intentionally rejects secret inputs and custom client IDs on add and update that the tools previously accepted. Shared-credential adds and Microsoft tenant updates remain supported, custom credentials must be configured in the Neon Console, and OAuth provider results no longer expose secrets.
