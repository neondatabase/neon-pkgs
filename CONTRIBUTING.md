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
pnpm test:e2e:live    # e2e suites against a real Neon org — needs credentials, see below
```

Scope a command to a single package with a filter:

```bash
pnpm --filter @neon/env build
pnpm --filter @neon/env test:ci
```

Workspace packages import each other through their build output (`dist`), not their source, so
a package's tests see a dependency's **last build** — not the source you just edited. `pnpm test`
therefore builds the package and its workspace dependencies first (`pnpm --filter <pkg>... build`),
which is what makes a single-package test run trustworthy after an edit anywhere in the graph.
`test:ci` skips that: on CI, `pnpm install` runs each package's `prepare` (a build) on a fresh
checkout, so everything is current already. Run `test:ci` locally only right after a build.

See [`AGENTS.md`](./AGENTS.md) for the deeper architecture and per-package notes (especially the
CLI package, which keeps its own toolchain).

Some packages add their own contributing notes for rules that only apply there. Read the
package's file before changing it:

| Package | Notes |
| --- | --- |
| [`@neon/env`](./packages/env/CONTRIBUTING.md) | Why the credential-reuse half lives in `shared/env-core` rather than on the published surface, and the branch-credential rules |

## Live Neon e2e tests

`pnpm test:e2e:live` runs the `@neon/sdk`, `@neon/config`, `@neon/config-runtime`, `@neon/env`,
and `neon` (the CLI) e2e suites against the real Neon API, creating and deleting real projects. The
CLI suite spawns the built binary and parses its JSON output. All of them are excluded
from `pnpm test:ci`, so you only pay for them when you ask for them.

### Setup

You need a Neon organization you are willing to lose. **The suites delete every project named
`neon-ts-e2e-*` that the key can see**, so never point them at an org holding anything you care
about, and never at a personal or production one. The org must be on the **Launch plan or
above** — one test protects a branch, which the free plan disallows.

1. Create a throwaway organization in the [Neon console](https://console.neon.tech).
2. Create an **organization-scoped** API key in that org's settings. Org-scoped matters: the key
   physically cannot see anything outside that org, so the cleanup sweep can't reach your other
   projects. A user-scoped key works too, but then `NEON_ORG_ID` is effectively required.
3. Copy any package's `.env.example` to a `.env` **at the repository root** and fill it in. All
   five suites read the root file, so you configure this once:

   ```bash
   cp packages/sdk/.env.example .env
   ```

   ```bash
   NEON_API_KEY=napi_...                    # the org-scoped key from step 2
   NEON_ORG_ID=org-...                      # the throwaway org
   ```

4. Run them:

   ```bash
   pnpm test:e2e:live                       # all five suites
   pnpm --filter @neon/sdk test:e2e         # just one
   ```

### Environment variables

| Variable | Required | Meaning |
| --- | --- | --- |
| `NEON_API_KEY` | yes | Org-scoped key for the throwaway org |
| `NEON_ORG_ID` | recommended | Pins project creation, listing and cleanup to one org. Required in practice for a user-scoped key |
| `NEON_PROJECT_ID` | only for project-scoped keys | Targets a fixed project; tests that need to create one skip themselves |
| `NEON_API_BASE_URL` | no | Point at a non-production API. Defaults to `https://console.neon.tech/api/v2` |

Values resolve highest-priority-first: a real environment variable, then the package's own
`.env`, then the repository-root `.env`. So exporting a variable in your shell overrides the
file, and a package-local `.env` overrides the root one when you need a single suite to differ.

`.env` files are gitignored (`.env.example` is the tracked exception). Don't commit one.

Adding a **new** variable? Read it through `tests/e2e-harness`, add it to every package's
`.env.example` and to the table above, and — for CI — see the "How CI supplies them" steps in
[`AGENTS.md`](./AGENTS.md), which cover the repository secret or variable and the workflow
mapping.

### The AI Gateway suite

`pnpm --filter @neon/ai-sdk-provider test:e2e` is the sixth live suite and is **not** part of
`test:e2e:live`, because a run calls well over a hundred live models — it exercises every model
the branch serves on two major AI SDK versions.

It takes the same `NEON_API_KEY` and provisions its own gateway: a throwaway project, then a
branch credential scoped to `ai_gateway:invoke`, both removed when the run ends. The gateway
exists on every branch and needs no setup, but **model access is granted per account**, so the
account behind the key needs every id in `packages/ai-sdk-provider/e2e/helpers.ts`. To run
against a branch you already have instead, set `NEON_AI_GATEWAY_BASE_URL` and
`NEON_AI_GATEWAY_TOKEN` (both, or neither) from `neon env pull`.

### In CI

These run as the `e2e (live Neon)` workflow on every pull request from this repository, using a
maintained throwaway org. The gateway suite runs as `e2e (live AI Gateway)`, path-filtered to
changes under `packages/ai-sdk-provider/` and `tests/e2e-harness/` so its model spend tracks
the code it covers. Both workflows map the repository secret `NEON_TEST_API_KEY` onto
`NEON_API_KEY` and the repository variable `NEON_TEST_ORG_ID` onto `NEON_ORG_ID`, so the
contract is identical to your local one.

Fork and Dependabot PRs skip the job, because GitHub does not expose repository secrets to
untrusted pull request code. **You do not need credentials to contribute** — open the PR and a
maintainer will run the suite before merging.

The shared plumbing lives in `tests/e2e-harness`, a private workspace package that is never
published; see its README for the cleanup rules it enforces.

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
