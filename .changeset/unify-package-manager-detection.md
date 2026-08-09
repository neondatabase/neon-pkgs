---
"neon": patch
---

Install commands now use your project's package manager everywhere, not just in `neon config init`

`neon bootstrap` and the `neon init` getting-started and migration steps told agents to run `npm install`, `npm install @neondatabase/serverless`, and `npm install -D prisma` regardless of the project's lockfile — which fails outright in a pnpm project, where npm's resolver chokes on the symlinked `node_modules`. They now emit the command for the manager the project actually uses (`pnpm add -D prisma`, `bun add -d drizzle-kit`, and so on). The global `neonctl` and `skills` installs follow the package manager that invoked the CLI instead of always using npm.
