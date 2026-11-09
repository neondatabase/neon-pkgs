---
"@neon/sdk": minor
"@neon/tools": minor
---

Add `neon.auth.logsExport.update({ projectId, branchId, enabled })` and the `auth.logsExport.update` tool, which turn the export of Neon Auth events to Neon Platform logs on or off for a branch. `@neon/sdk/raw` gains `updateNeonAuthLogsExport`. The refreshed spec also adds `discord` to `NeonAuthOauthProviderId` and `logs_export` to `NeonAuthPluginConfigs`.
