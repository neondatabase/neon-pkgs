---
"@neon/sdk": minor
---

`error.kind` now narrows. `NeonResult` and `RawResult` type `error` as `NeonErrorUnion`, and every error class carries a literal `kind`, so `if (error?.kind === "not_found") error.status` compiles without `instanceof`. New `NeonClientError` (`kind: "client"`) replaces the bare `NeonError` the SDK used for SDK-side failures. `instanceof NeonError` still matches. `NeonApiError` is now `NeonApiError<K = "api">`; annotate `NeonApiError<NeonApiErrorKind>` if you need a variable that also holds 404/401/429 subclasses.
