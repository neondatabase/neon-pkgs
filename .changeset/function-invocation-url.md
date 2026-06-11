---
"@neondatabase/config-runtime": patch
---

Surface each deployed function's invocation URL in `plan` / `apply` results.

`pushConfig` now adds an `invocationUrl` to the `details` of every `function:<slug>` change in `PushResult.applied`, so callers (e.g. `neonctl deploy`) can show users where to call a function right after deploying it. The URL comes from the preview state already fetched for the diff; a function created by its first deployment in the same push triggers a single extra `listBranchFunctions` to learn its freshly-minted URL (best-effort — a failed re-list simply omits the URL).
