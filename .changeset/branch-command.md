---
"@neondatabase/platform": minor
---

Add `branch()` SDK function and `neon-ts branch <blueprint>` CLI command for creating ephemeral branches from a wildcard blueprint in `neon.ts`. The new name is composed as `<pattern with * replaced by normalised-git-branch + mini-id>` (or just `<mini-id>` when git isn't available), the blueprint's `parent`, `ttl`, and `computeSettings` are applied on Neon, and an existing `.neon[/project.json]` file is updated in place with the resulting `branchId` so subsequent `loadEnv` / `pullConfig` calls target the new branch.

`neon-ts pull` now writes (or overwrites) `./neon.ts` in the current directory by default and prints a one-line `✓ Created/Updated <path>` status instead of dumping the snippet to stdout — the next step after pulling is invariably `import`ing the file, so having to redirect `> neon.ts` was friction with no upside. Pass `--format json` to opt back into stdout output (raw `Config` JSON for piping into `jq` / your own file).
