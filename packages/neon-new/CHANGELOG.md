# neon-new

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
