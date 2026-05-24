---
"@neondatabase/platform": minor
---

Split the branch surface in `neon.ts` into two intentionally distinct maps:

- **`branches`** (new) — concrete, persistent branches managed by `pushConfig`. The map key is the literal branch name on Neon, settings describe a single branch, and entries support a new `protected: boolean` flag for marking branches as protected.
- **`branchBlueprints`** (tightened) — templates for *ephemeral* branches spun up via `branch()`. Every blueprint's `pattern` is now **required** and **must contain a `*` wildcard**; specific-name entries belong in `branches` instead.

`pullConfig` materialises concrete branches into `config.branches` (including the `protected` flag) and drops ephemeral branches with a future `expiresAt` — listing live branches at runtime is `neonctl branches list`'s job, not config-as-code's. The newly-added `protected` drift is reported as a conflict by default and applied with `updateExisting: true`, mirroring the existing compute-settings drift handling.

Add `branch()` SDK function and `neon-ts branch <blueprint>` CLI command for creating ephemeral branches from a wildcard blueprint. The new name is composed as `<pattern with * replaced by normalised-git-branch + mini-id>` (or just `<mini-id>` when git isn't available), the blueprint's `parent`, `ttl`, and `computeSettings` are applied on Neon, and an existing `.neon[/project.json]` file is updated in place with the resulting `branchId` so subsequent `fetchEnv` / `pullConfig` calls target the new branch.

`neon-ts pull` now writes (or overwrites) `./neon.ts` in the current directory by default and prints a one-line `✓ Created/Updated <path>` status instead of dumping the snippet to stdout — the next step after pulling is invariably `import`ing the file, so having to redirect `> neon.ts` was friction with no upside. Pass `--format json` to opt back into stdout output (raw `Config` JSON for piping into `jq` / your own file).
