---
"@neon/tools": major
---

`inject` keys are `project_id` / `branch_id`. Omit `mode` or pass `"pin"` (field removed from the schema). Pass `mode: "fallback"` for caller-wins fill. `execute` omits only path keys required on the inject object. A `NeonToolInjectOptions` union (a parameter) does not omit them.
