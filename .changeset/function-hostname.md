---
"@neon/functions": minor
"@neon/env": major
"@neon/config": major
"@neon/config-runtime": major
"neon": major
---

Add `functionHostname(slug)` to `@neon/functions` to resolve a sibling function's host
from `NEON_BRANCH_ID` and the leading-dot `NEON_FUNCTION_HOST_SUFFIX`. Under `neon dev`,
the helper automatically returns the assigned localhost port for each function being served.

Export the branch ID and function host suffix through local env resolution, including
`neon env pull`, `neon dev`, and `neon-env run`, so the same helper works locally and
in deployed functions.

Remove per-function `NEON_FUNCTION_<SLUG>_BASE_URL` variables and their selectors,
`env.functions`, and the `functionBaseUrlKey`, `isFunctionBaseUrlKey`, and
`parseFunctionBaseUrlKey` exports and associated URL types from `@neon/env`.
Replace reads of these URLs with `functionHostname(slug)`; use `http://` for
`localhost:<port>` and `https://` for deployed hosts. Existing dotenv lines can be deleted.
The scoped `parseEnv(config, slug).function` namespace for declared secrets is unchanged.

Remove the per-function URL namespace from `HookEnv` in `@neon/config` too.
Hooks now receive the branch ID and shared function host suffix in `env.branch`;
shell hooks receive the matching environment variables.
