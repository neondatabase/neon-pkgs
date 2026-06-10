---
"@neondatabase/config": minor
---

`DurationString` for `computeSettings.suspendTimeout` and branch `ttl`: autocomplete + a required unit.

Both fields previously typed the duration as a bare `string`, which collapsed literal hints
(no editor suggestions) and let a bare numeric string like `"7"` silently mean *7 seconds*.
They now use a shared `DurationString`:

- Common values (`"1m"`, `"5m"`, `"1h"`, `"7d"`, …) autocomplete inside `""`, while any
  `` `${integer}${unit}` `` string (`"45m"`, `"2w"`, …) still type-checks.
- A **unit is now required**: `"7"` is rejected at the type level — pass a `number` (`7`) for
  raw seconds, or add a unit (`"7d"`). `parseDuration` enforces the same at runtime with a
  targeted error, so a unit-less string no longer parses as seconds.

**Breaking:** a bare numeric **string** (e.g. `"3600"`) is no longer accepted for `ttl` /
`suspendTimeout` — use the `number` form (`3600`) or add a unit. Richer typedoc with units
(`s`/`m`/`h`/`d`/`w`), ranges, and scale-to-zero / branch-expiry examples; `DurationString`,
`DurationUnit`, and `ComputeUnit` are exported from `@neondatabase/config/v1`.
