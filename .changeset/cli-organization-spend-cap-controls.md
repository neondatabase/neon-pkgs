---
"neon": minor
---

Add `org spend-cap get`, `set --amount`, and `disable`, with support for table, JSON, and YAML status output. New limits default to service suspension when available; amount-only updates to existing limits preserve their saved setting. Use `--spend-cap-enabled=false` for notifications only. Disabling keeps the notification amount. Report asynchronous acknowledgements, current-invoice usage, warnings, and monitoring delay, and show actionable Organization Billing guidance for spend-cap denials across existing commands.
