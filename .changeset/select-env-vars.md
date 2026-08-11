---
"neon": patch
"@neon/env": patch
---

Add exact environment-variable selection to `neon env pull`, and scope `fetchEnv({ keys })` work to the selected variables. Literal key lists autocomplete and narrow exactly, runtime-built lists return safely optional fields, and storage credential halves must be selected together.
