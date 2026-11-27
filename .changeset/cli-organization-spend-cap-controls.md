---
"neon": minor
---

Extend `org(s) spending-limit` with `set --amount`, `--suspend-on-limit[=false]`, and `disable`, preserving `get`, `set <usd>`, and `delete`, with support for table, JSON, and YAML status output. New limits default to service suspension when available; amount-only updates to existing limits preserve their saved setting. Use `--suspend-on-limit=false` for notifications only. Disabling uses the atomic bodyless POST endpoint to retain the current notification amount, including concurrent changes or deletion, and requires server support without retries or legacy fallback. Report asynchronous acknowledgements, current-invoice usage, warnings, and monitoring delay, and show actionable Organization Billing guidance for spending-limit denials across existing commands.
