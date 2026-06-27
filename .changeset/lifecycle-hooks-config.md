---
"@neondatabase/config": minor
---

Add lifecycle hooks (Preview) and a `toNeonBranchName` / `slugify` helper.

- New top-level `hooks` policy field with `checkout` and `deploy` phases, each exposing a `before` (influence/abort) and `after` (observe) hook. A hook is a function `(ctx) => …` or a shell command (string or array). Hooks are the imperative companion to the pure `branch()` closure and are read by the runtime only on the real `checkout` / `deploy` commands — never during `plan` / `status` / `inspect`.
- New hook context types: `Hooks<C>`, `CheckoutHooks<C>`, `DeployHooks<C>`, `CheckoutBeforeContext`, `CheckoutBeforeResult`, `CheckoutAfterContext<C>`, `DeployBeforeContext`, `DeployAfterContext<C>`, `GitContext`, `HookBranch`, `Hook`, `ShellHook`. The `after` contexts are generic over the policy so their `env` is the **exact** `NeonEnv<typeof config>` — `env.auth` / `env.dataApi` / `env.storage` / `env.aiGateway` are present iff the policy enables them (no `unknown` escape hatch).
- The canonical `NeonEnv<C>` type family now lives in this package (`NeonEnv`, `NeonPostgresEnv`, `NeonBranchEnv`, `NeonAuthEnv`, `NeonDataApiEnv`, `NeonStorageEnv`, `NeonAiGatewayEnv`, `FunctionSlugOf`, `NeonFunctionEnv`). It's a pure, runtime-free shape derived from `Config`, so config can type a `neon.ts` hook's `env` exactly without a `config` → `env` dependency cycle. `@neondatabase/env` re-exports these, so its public surface is unchanged.
- New `toNeonBranchName` helper (and `ToNeonBranchNameOptions`) that derives a valid, stable Neon branch name from an arbitrary string (e.g. a git branch) — shared with the CLI's git → Neon mapping. Pass `preserveSlashes: false` for a single flat token.
- `schemas.hooks` is added to the exported schema namespace.
