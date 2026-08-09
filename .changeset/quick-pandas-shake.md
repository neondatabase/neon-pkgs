---
"neon": patch
---

Install the config packages with the package manager the project actually uses

`neon config init` (and the `neon link` prompt that runs it) picked a package manager from `npm_config_user_agent` alone, which is empty for a globally installed `neon`. It then fell back to the first manager on `PATH`, effectively always npm — so setting up a pnpm, yarn, or bun project shelled out to `npm install`. In a pnpm project that fails outright: npm's dependency resolver chokes on pnpm's symlinked `node_modules` with `Cannot read properties of null (reading 'matches')`. The install leaves a `neon.ts` whose `@neon/config/v1` import can't resolve, so the env pull that follows fails too.

`resolvePackageManager` now reads the project's lockfile first, from the target directory and its parents up to the repo root — so a package in a monorepo finds the root lockfile, while a stray lockfile above the repository is ignored. A project with no lockfile falls back to the previous behaviour unchanged.
