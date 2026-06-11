---
"@neondatabase/config": minor
"@neondatabase/config-runtime": minor
"@neondatabase/env": minor
---

Remove the function `memoryMib` setting entirely.

**Breaking.** Function memory is no longer user-configurable from `neon.ts` or the deploy
API surface — it is fixed by the platform policy.

- `@neondatabase/config`: drop `FunctionMemoryMib`, remove `memoryMib` from `FunctionTuning`,
  `ResolvedFunctionConfig`, and `DeployFunctionInput`. The real NeonApi adapter no longer
  sends a `memory_mib` form field.
- `@neondatabase/config-runtime`: stop threading `memoryMib` through plan/apply steps.
- A `neon.ts` that sets `branch.preview.functions[slug].memoryMib` is now a type error and
  is rejected by the schema.
