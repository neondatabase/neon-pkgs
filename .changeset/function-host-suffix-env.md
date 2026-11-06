---
"@neon/env": major
---

Add `functionBaseUrl(slug)`, which returns another Neon Function's base URL on the same branch from `NEON_BRANCH_ID` and `NEON_FUNCTION_HOST_SUFFIX`, the variables the Functions runtime injects into every function, or `http://localhost:<port>` for a slug `neon dev` is serving. `fetchEnv`, `parseEnv`, and `toEntries` carry both variables on `env.branch` (`id`, `functionHostSuffix`).

**Breaking:** the per-function `NEON_FUNCTION_<SLUG>_BASE_URL` contract is removed: `env.functions`, `functionBaseUrlKey`, `isFunctionBaseUrlKey`, `parseFunctionBaseUrlKey`, and the `FunctionBaseUrlKey`, `NeonFunctionsEnv`, `NeonFunctionUrlEnv`, and `ParsedNeonEnv` types. Replace `env.functions.hello.baseUrl` with `functionBaseUrl("hello")`.
