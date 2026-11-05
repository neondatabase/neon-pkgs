---
"@neon/functions": minor
"@neon/env": minor
"neon": minor
---

Add `functionHostname(slug)` to `@neon/functions` to resolve a sibling function's host
from `NEON_BRANCH_ID` and the leading-dot `NEON_FUNCTION_HOST_SUFFIX`. Per-function
`NEON_FUNCTION_<SLUG>_BASE_URL` values take precedence, including localhost URLs
injected by `neon dev`.

Export the branch ID and function host suffix through local env resolution, including
`neon env pull`, `neon dev`, and `neon-env run`, so the same helper works locally and
in deployed functions.
