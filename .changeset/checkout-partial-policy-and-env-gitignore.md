---
"@neon/config": minor
"@neon/config-runtime": minor
"neonctl": minor
---

Stop stranding a branch when `neon checkout` creates one whose `neon.ts` policy fails to apply, and keep pulled dotenv files out of git.

`createBranch` pushes the policy *after* the branch exists, so a rejected setting (a plan-gated compute value, a service that can't be provisioned) threw with the created branch's id lost: the branch stayed behind, `.neon` was never pinned, no env was pulled, and a re-run silently accepted the half-configured branch because `checkout` never reconciles a branch that already exists. It now throws `PartialBranchCreateError` — exported from `@neon/config` with `branchId` / `branchName` / `reason` plus an `isPartialBranchCreateError` guard — and `neon checkout` uses it to pin the branch and pull its env before failing with the cause and both recovery paths (`neon deploy --update-existing`, or delete and check out again for a policy keyed on `!branch.exists`).

`neon env pull` — including the pull bundled into `link` / `checkout` / `deploy` — now adds a dotenv file it creates to `.gitignore`, the same way the `.neon` context file is handled, so a live `DATABASE_URL` isn't one `git add -A` from being committed. Nothing is appended when an existing pattern such as `.env*` or `*.local` already covers the file, and a dotenv file that already existed is left alone.

`checkout`'s policy summary now prints the same field-level diff as `neon deploy` (`computeSettings.autoscalingLimitMaxCu → 2`) instead of repeating the branch name once per change.
