# neon-new

## 0.15.1

### Patch Changes

- b8217bc: Name the database Lakebase Postgres, and stop calling Neon a platform

  Copy only, no behaviour change beyond one error message string.

  - `neon`: the npm description no longer says "Neon Serverless Postgres"; the README names the primitives the CLI manages.
  - `@neon/config` and `@neon/config-runtime`: "Config-as-Code for the Neon Platform" is now "Config-as-Code for Neon", in the npm descriptions, the README, and the `v1` doc comments.
  - `@neon/config`: the validation error `Invalid Neon platform config:` is now `Invalid Neon config:`. Anything matching on that string needs updating.
  - `neon-init`: `neon-init auth` is described as "Manage Neon authentication"; the signup prompt no longer calls Neon "a serverless Postgres provider"; two bootstrap template blurbs say Lakebase Postgres.
  - `neon-new`: README says "a claimable Lakebase Postgres database on Neon" — claimable databases are Neon-only, so the access path is named.

## 0.15.0

### Minor Changes

- Support Node.js >= 20.19 at runtime. Every published package now declares
  `engines.node: ">=20.19.0"` — the real floor of its dependency tree — instead of `>=22`, so the
  packages install and run cleanly on Node 20 without any dependency downgrades (`neonctl` moves
  from `>=20.18.1` to `>=20.19.0` to match `chokidar@5`). Contributing to the repo still requires
  Node 22 (pnpm + SDK codegen); see `CONTRIBUTING.md`.

## 0.14.0

### Minor Changes

- 2e7957d: Rename packages: get-db is now neon-new, vite-plugin-db is now vite-plugin-neon-new. The old package names continue to work but are deprecated and will show warnings. Please update your dependencies to use the new package names.

## 0.13.0

Initial release (renamed from `get-db`).
