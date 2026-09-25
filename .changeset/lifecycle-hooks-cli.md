---
"neon": minor
---

Add experimental lifecycle hooks (`experimental.hooks` in `neon.ts`) and a `neon git` command group for syncing the checked-out Neon branch to your git branch.

`checkout` runs `checkout.before` (can rewrite the branch name to check out) and, only when it actually creates a branch, `create.before` (can abort the create) — then, once the branch is pinned, `checkout.after` and `create.after` with the resolved branch env. `deploy` runs `deploy.before` before applying `neon.ts` and `deploy.after` once the apply succeeds.

`neon git install` installs a `post-checkout` git hook that runs `neon git sync`, mapping the current git branch to a Neon branch (sticky once resolved) and delegating to `neon checkout`. `neon git status` shows the mapping and hook state; `neon git cleanup` prunes stale mappings and, with `--prune-neon-branches`, deletes the orphaned Neon branches (never the default or a protected branch); `neon git uninstall` removes the hook.
