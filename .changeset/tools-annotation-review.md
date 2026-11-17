---
"@neon/tools": patch
---

`auth.webhooks.update` now sets `openWorldHint: true`, because it points Neon Auth at a webhook URL the caller chooses. `realtime.enable` says that enabling turns on logical replication for the whole project for good and suspends every compute in it, and asks the agent to confirm with the user first. `branches.describe` says it is read-only and changes no data.
