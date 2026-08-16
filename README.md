# Neon JavaScript/TypeScript packages

The monorepo for [Neon](https://neon.com)'s open-source JavaScript/TypeScript SDKs, libraries, CLIs, and framework plugins. Each folder under [`packages/`](./packages) is an independently versioned, separately published package; they share tooling (pnpm workspaces, Biome, tsdown, Vitest, Changesets) but ship on their own cadence.

If you're looking for a single package's docs, see its own `README.md` under `packages/<name>/`.

## Packages

### Neon CLI

| Package | Description |
| --- | --- |
| `neon` | The Neon CLI. Install this package for the `neon` command. |
| `neonctl` | Compatibility package that delegates to `neon`. Provides the legacy `neonctl` command (plus `neon`) and is what Homebrew builds from. |

### Provisioning & project setup

| Package | Description |
| --- | --- |
| `neon-new` | A CLI tool and SDK for creating claimable Neon databases instantly. |
| `vite-plugin-neon-new` | A Vite plugin that automatically provisions databases during development. |

### Config-as-Code (`neon.ts`)

| Package | Description |
| --- | --- |
| `@neon/config` | Config-as-Code for Neon: `defineConfig` types + the pure diff engine and Neon API adapter behind a `neon.ts` policy. |
| `@neon/config-runtime` | Runtime for `neon.ts` policies — `inspect` / `plan` / `apply` (push/pull) plus function bundling and deploy. |
| `@neon/env` | Resolve and inject a branch's Neon env (`fetchEnv` / `parseEnv`, `neon-env run`) from a `neon.ts` policy. |

### API & integrations

| Package | Description |
| --- | --- |
| `@neon/sdk` | The official TypeScript SDK for the Neon API — a modern, Fetch-based client generated from Neon's OpenAPI spec (successor to `@neondatabase/api-client`). |
| `@neon/tools` | Generated, type-safe agent tools for every Neon Management API operation, with MCP, Eve, and Mastra adapters. |
| `@neon/functions` | Runtime helpers for Neon Functions (e.g. a `waitUntil` primitive for deferring work past a response). |
| `@neon/ai-sdk-provider` | Community [Vercel AI SDK](https://ai-sdk.dev) provider for the Neon AI Gateway. |

A few renamed packages are still published as deprecated aliases (`get-db` / `neondb` → `neon-new`; `vite-plugin-db` / `@neondatabase/vite-plugin-postgres` → `vite-plugin-neon-new`); they re-export the new package and print a deprecation warning. `neonctl` is not deprecated: it is a supported compatibility package that installs and runs `neon`.

`neon-init` is **deprecated and no longer built from this repo**. Everything it did is the
`neon init` command, so the command is `npx neon init`. There is no alias package: it was a
CLI rather than a library, and the replacement is a command on a CLI most users already have.

## Repository layout

```
packages/   # the published SDKs, libraries, CLIs, and plugins (one per folder)
tests/      # test-only tooling that is never published (the live Neon e2e harness)
examples/   # runnable examples that consume the packages via the workspace
```

This is a [pnpm workspace](https://pnpm.io/workspaces). Internal dependencies are linked with `workspace:*`, so changes to one package are immediately visible to its dependents without republishing.

## Development

Contributing to this repo requires **Node.js >= 22** and [pnpm](https://pnpm.io) — pnpm itself needs Node 22.13+, and regenerating the `@neon/sdk` types needs Node 22.18+. The **published packages** support **Node.js >= 20.19** at runtime (see each package's README and `CONTRIBUTING.md`). From the repo root:

```bash
pnpm install          # install all workspaces
pnpm build            # build every package (tsc + tsdown)
pnpm test:ci          # run the test suites (Vitest)
pnpm lint:ci          # lint + format check (Biome)
```

Scope a command to a single package with a filter, e.g.:

```bash
pnpm --filter @neon/env build
pnpm --filter @neon/env test:ci
```

## Releasing

Versioning is driven by [Changesets](https://github.com/changesets/changesets). Add a changeset describing your change (`pnpm changeset`), and a maintainer applies the version bumps + changelogs (`pnpm changeset version`) on a release PR. Publishing to npm runs from a separate workflow once that PR lands on `main`.

## License

Every package in this repository is licensed under **Apache-2.0**.
