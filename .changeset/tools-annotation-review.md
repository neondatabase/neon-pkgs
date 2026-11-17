---
"@neon/tools": patch
---

`auth.webhooks.update`, `auth.emailProvider.update`, and `postgres.dataApi.create` now set `openWorldHint: true`, because they point Neon at an endpoint the caller chooses: a webhook URL, an SMTP host, or a JWKS URL. `realtime.enable` says that enabling turns on logical replication for the whole project for good and suspends every compute in it, and asks the agent to confirm with the user first. `branches.describe` says it is read-only and changes no data.
