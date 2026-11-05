---
"@neon/sdk": minor
"@neon/tools": minor
"@neon/effect": minor
---

Add `neon.organizations`: `get`, `members.list|get|update|remove`, `invitations.list|create`, `spendingLimit.get|set|delete`, and `apiKeys.list|create|revoke` for organization API keys. Every method takes `orgId` and defaults to the client's `orgId`. `@neon/tools` publishes them as `organizations.*` tools, with approval required for every write, and `@neon/effect` streams `organizations.members.list`.
