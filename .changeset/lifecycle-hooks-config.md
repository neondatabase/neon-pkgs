---
"@neon/config": minor
---

Add experimental lifecycle hooks under `experimental.hooks` in `neon.ts`: `checkout.before`/`checkout.after`, `create.before`/`create.after`, and `deploy.before`/`deploy.after`. Each hook is a function (receiving a typed context with the triggering event, git facts, and — for `after` hooks — the resolved branch env) or a shell command string/array. New exported types: `Hooks`, `CheckoutHooks`, `CreateHooks`, `DeployHooks`, `CheckoutEvent`, `DeployEvent`, `GitContext`, `HookBranch`, `HookEnv`, `Hook`, `ShellHook`, and the per-phase context/result types.
