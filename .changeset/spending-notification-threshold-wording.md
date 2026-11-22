---
"neon": patch
"@neon/tools": patch
"@neon/sdk": patch
---

Describe the organization spending limit as a spending notification threshold. `neon orgs spending-limit` help, table output, and messages, the `organizations.spendingLimit.*` tool descriptions, and the SDK's `OrganizationSpendingLimit` docs now say it sets a threshold that emails organization admins at 80% and 100% and never suspends computes. The command name, SDK methods, and the API's `spending_limit_cents` field are unchanged.
