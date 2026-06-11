---
"@neondatabase/config-runtime": patch
---

Trim noise from `plan` / `apply` change details. The `auth` / `dataApi` / `aiGateway` toggles no longer carry a `details` blob (they're plain branch on/off switches — the auto-derived `databaseName` was never policy-controlled, and `branchName` just repeats the command's target branch on every row). `bucket` / `function` changes keep their meaningful fields (`accessLevel`, `name`, `source`, `runtime`, …) but drop the redundant `branchName`. Plan and apply stay in sync.
