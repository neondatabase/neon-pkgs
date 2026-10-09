---
"neon": patch
---

Keep OAuth credentials within the Windows keyring limit by storing only the fields the CLI uses, and report an actionable error before oversized keyring writes.
