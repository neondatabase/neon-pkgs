---
"@neondatabase/env": patch
---

Source the `NeonEnv` type family from `@neondatabase/config` (its new canonical home) and re-export it. No public API change — `NeonEnv`, `NeonPostgresEnv`, `NeonAuthEnv`, `NeonDataApiEnv`, `NeonStorageEnv`, `NeonAiGatewayEnv`, `NeonBranchEnv`, `FunctionSlugOf`, and `NeonFunctionEnv` are still exported from `@neondatabase/env/v1` with identical shapes (verified by the existing type tests). Moving the *type* (a pure shape derived from `Config`) to `config` lets `config` type `neon.ts` lifecycle-hook `env` as the exact `NeonEnv<typeof config>` without a dependency cycle; `@neondatabase/env` keeps the runtime that produces it (`fetchEnv` / `parseEnv` / `toEntries`).
