---
"@neondatabase/config": minor
---

`DurationString` for `computeSettings.suspendTimeout` and branch `ttl`: per-field autocomplete (within API limits) + a required unit.

Both fields previously typed the duration as a bare `string`, which collapsed literal hints
(no editor suggestions) and let a bare numeric string like `"7"` silently mean *7 seconds*.
Now:

- **Per-field autocomplete that fits the Neon API.** `suspendTimeout` suggests values in the
  scale-to-zero band `"1m"`–`"7d"` (the API allows 60s–604800s). `ttl` suggests `"1h"`–`"30d"`
  (the API caps branch expiration at 30 days). Both remain open: any other
  `` `${integer}${unit}` `` string or a `number` of seconds still type-checks.
- **A unit is now required.** `"7"` is rejected at the type level and at runtime
  (`parseDuration`) — pass a `number` (`7`) for raw seconds, or add a unit (`"7d"`).
- **Branch TTL is range-checked.** A new `parseBranchTtl` rejects TTLs over 30 days with a
  clear error instead of deferring to an API failure.

**Breaking:** a bare numeric **string** (e.g. `"3600"`) is no longer accepted for `ttl` /
`suspendTimeout` (use the `number` form or add a unit), and a `ttl` over 30 days is rejected.
Richer typedoc with units (`s`/`m`/`h`/`d`/`w`), ranges, and scale-to-zero / branch-expiry
examples; `DurationString`, `DurationUnit`, and `ComputeUnit` are exported from
`@neondatabase/config/v1`.
