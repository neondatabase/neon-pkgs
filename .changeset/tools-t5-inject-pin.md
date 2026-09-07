---
"@neon/tools": major
---

`inject` keys are `project_id` / `branch_id`. Omit `mode` or pass `"pin"` (field removed from the schema). Pass `mode: "fallback"` for caller-wins fill. Old `inject: { projectId }` was caller-wins; renaming the key to `project_id` pins unless you add `mode: "fallback"`. A defined `inject` with neither key throws. `execute` omits only path keys required on the inject object. A `NeonToolInjectOptions` union (a parameter) does not omit them.
