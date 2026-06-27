---
"@neondatabase/config-runtime": minor
---

Add a lifecycle-hook runner that executes `@neondatabase/config` hooks.

- `runHook(hook, ctx, options?)` runs a hook's function form (awaited, value returned) or shell-command form, returning the function result (or `undefined` for shell hooks).
- `runShellHook(hook, options?)` runs a shell command (or sequential array) **non-interactively** — stdin is detached and `CI=1` is set, so an accidental interactive command (`drizzle-kit push`) fails fast instead of hanging — with Neon env vars injected into the command environment.
- `HookExecutionError` carries the failing command and its exit code/signal.
- Re-exports the hook + branch-name types/helpers (`toNeonBranchName`, `Hooks`, `GitContext`, …) from `@neondatabase/config` for one-stop CLI imports.
