---
"neon": patch
---

Install and tool commands now use your project's package manager everywhere, not just in `neon config init`

`neon bootstrap` and the `neon init` getting-started and migration steps told agents to run `npm install`, `npm install @neondatabase/serverless`, and `npm install -D prisma` regardless of the project's lockfile — which fails outright in a pnpm project, where npm's resolver chokes on the symlinked `node_modules`. They now emit the command for the manager the project actually uses (`pnpm add -D prisma`, `bun add -D drizzle-kit`, and so on).

The tools those steps then run follow the project too: `pnpm exec drizzle-kit migrate` and `bun run prisma generate` rather than `npx`. These are local-only forms, so a step that runs before its dependencies are installed now fails instead of silently downloading an unpinned copy of the tool.

The global `neonctl` and `skills` installs follow the package manager that invoked the CLI instead of always using npm, and report clearly when the machine has no way to install a CLI globally.
