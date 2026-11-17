---
"@neon/tools": minor
---

Tools return secrets as the API returns them. `secrets: "setup"` keeps only credentials Neon issues, such as connection strings and credential tokens, and `secrets: "none"` keeps none; hidden values read `"***redacted***"`. `metadata.secretOutputFields` lists each secret's path and kind. `auth.getConfig`, `auth.emailProvider.get`, `auth.emailProvider.update`, and `auth.plugins.get` no longer blank the SMTP password and OAuth client secrets by default, and `auth.getConfig`, `auth.emailProvider.get`, and `auth.plugins.get` now require approval.
