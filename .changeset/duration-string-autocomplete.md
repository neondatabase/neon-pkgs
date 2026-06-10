---
"@neondatabase/config": patch
---

Add a `DurationString` type for `computeSettings.suspendTimeout` and branch `ttl`, with autocomplete.

Both fields previously typed the duration as a bare `string`, which collapsed the literal
hints so editors offered no suggestions. They now use a shared `DurationString` —
common values (`"1m"`, `"5m"`, `"1h"`, `"7d"`, …) surface as autocomplete inside `""`, while
any valid `<number><unit>` string is still accepted (open literal union). `suspendTimeout`
and `ttl` also get richer typedoc with examples (units, ranges, scale-to-zero / branch-expiry
semantics). Non-breaking — purely a type/DX improvement; runtime validation is unchanged.
