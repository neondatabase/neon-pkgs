---
"@neon/tools": patch
---

`database.inspect` rethrows the driver's `NeonDbError` when the connecting role cannot log in, instead of reporting it as an `InspectDiagnosticError`.
