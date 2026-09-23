---
"neonctl": minor
---

Sync the Neon branch to your git branch + run `neon.ts` lifecycle hooks (Preview).

- New `neonctl git` command group: `install` / `uninstall` (manage a sentinel-guarded `post-checkout` hook, honoring `core.hooksPath`), `sync` (check out the Neon branch for the current git branch — defaulting the name to `git.neonSafeBranchName(gitBranch)` — with an opt-in `--pull` fast-forward), `status` (read-only git + mapping facts), and `cleanup` (prune stale `.neon` mappings, and with `--prune-neon-branches` delete orphaned Neon branches, never the default or a protected one).
- `checkout`, branch creation, and `deploy` now invoke the policy's `experimental.hooks` at their existing seams: `checkout.before` may rename or abort before the branch is resolved; `checkout.after` runs once the branch + env are resolved; `create.before` fires right before `checkout` actually creates a new branch (never for an existing one) and can abort but not rename; `create.after` runs once that new branch + env are resolved; `deploy.before` / `deploy.after` bracket the apply. The connection `env` is resolved in memory and passed to `after` hooks even under `--no-env-pull`, typed as the exact `NeonEnv<typeof config>`.
- `.neon` gains a `git` block (`{ follow, map }`, real Neon branch slugs as values); `set-context` / `link` preserve it on write.
- Consumes the hooks contract from `@neondatabase/config` + `@neondatabase/config-runtime` directly as in-repo workspace dependencies (replaces the prior `pnpm link` stand-in).
