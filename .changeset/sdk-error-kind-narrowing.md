---
"@neon/sdk": minor
---

`error.kind` now narrows. `NeonResult` and `RawResult` type `error` as `NeonErrorUnion`, and every error class carries a literal `kind`, so `if (error?.kind === "not_found") error.status` compiles without `instanceof`. New `NeonClientError` (`kind: "client"`) replaces the bare `NeonError` the SDK used for SDK-side failures. `isNeonError` is the type guard for `catch` after `throwOnError`. `instanceof NeonError` still matches; `instanceof NeonApiError` still matches 404/401/429 subclasses.
