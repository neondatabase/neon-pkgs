---
"neon": patch
---

When a successful Neon API response has a body that cannot be parsed, commands now fail with `Could not read the Neon API response (<status>) to <path>: <reason>` instead of crashing with `TypeError: Cannot read properties of undefined`.
