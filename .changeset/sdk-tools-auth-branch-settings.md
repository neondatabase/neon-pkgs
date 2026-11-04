---
"@neon/sdk": minor
"@neon/tools": minor
---

Add Neon Auth branch settings to `neon.auth`: `allowLocalhost.get|update`, `emailAndPassword.get|update`, `emailProvider.get|update|sendTest`, `plugins.get`, `plugins.magicLink.update`, `plugins.organization.update`, `plugins.phoneNumber.get|update`, and `webhooks.get|update`, with matching `auth.*` tools. The email provider and plugins tools return the SMTP password and OAuth client secrets as `""`.
