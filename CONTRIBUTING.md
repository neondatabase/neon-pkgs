# Contributing

Thanks for contributing to Neon's JavaScript/TypeScript packages!

## Node.js versions — the two floors

This repo has **two distinct Node.js requirements**, and they are intentionally different:

| Audience | Node.js | Why |
| --- | --- | --- |
| **Contributors** (developing in this repo) | **>= 22** | The toolchain needs it: `pnpm` (10.x) requires Node **22.13+** (it uses `node:sqlite`), and regenerating the `@neon/sdk` types with `@hey-api/openapi-ts` requires Node **22.18+**. |
| **End users** (installing a published package) | **>= 20.19** | Every published package declares `engines.node: ">=20.19.0"`. That is the true floor of the runtime dependency trees (driven by `chokidar@5` / `yargs@18`); nothing published needs Node 22. |

In short: **you build and test on Node 22+, but everything we ship runs on Node 20.19+.** The
repo root `package.json` declares `engines.node: ">=22"` for exactly this reason — it describes
the *contributor* environment, not the published packages.

> Node 20 reached end-of-life on 2026-04-30. We continue to support it as a grace window for
> users who haven't upgraded yet; expect the floor to move to Node 22 once Node 20 usage is
> negligible.

### Using nvm

```bash
nvm install 22 && nvm use 22   # contributor toolchain
```

To sanity-check that a build still runs on the published floor, you can run the built artifacts
(not `pnpm`, which needs 22.13+) under Node 20.19+:

```bash
nvm install 20 && nvm exec 20 node packages/cli/dist/cli.js --version
```

## Development

```bash
pnpm install          # install all workspaces
pnpm build            # build every package (tsc + tsdown)
pnpm test:ci          # run the test suites (Vitest)
pnpm lint:ci          # lint + format check (Biome)
```

Scope a command to a single package with a filter:

```bash
pnpm --filter @neon/env build
pnpm --filter @neon/env test:ci
```

See [`AGENTS.md`](./AGENTS.md) for the deeper architecture and per-package notes (especially the
CLI package, which keeps its own toolchain).

## Changing the supported Node floor

If you bump a dependency that raises the runtime floor, update **every published package's**
`engines.node` accordingly, refresh the `> **Requirements:**` note in each package `README.md`,
and update the table above. Don't lower a package's `engines` below what its dependency tree
actually supports.

## Changesets

User-facing changes need a changeset:

```bash
pnpm changeset        # pick package(s) + bump + summary
```

Commit the generated `.changeset/*.md` with your PR. See the "Release Management" section of
[`AGENTS.md`](./AGENTS.md) for how releases are cut and published.
