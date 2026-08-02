# vite-plugin-neon-new

## 0.9.1

### Patch Changes

- Updated dependencies [b8217bc]
  - neon-new@0.15.1

## 0.9.0

### Minor Changes

- Support Node.js >= 20.19 at runtime. Every published package now declares
  `engines.node: ">=20.19.0"` — the real floor of its dependency tree — instead of `>=22`, so the
  packages install and run cleanly on Node 20 without any dependency downgrades (`neonctl` moves
  from `>=20.18.1` to `>=20.19.0` to match `chokidar@5`). Contributing to the repo still requires
  Node 22 (pnpm + SDK codegen); see `CONTRIBUTING.md`.

### Patch Changes

- Updated dependencies
  - neon-new@0.15.0

## 0.8.0

### Minor Changes

- 2e7957d: Rename packages: get-db is now neon-new, vite-plugin-db is now vite-plugin-neon-new. The old package names continue to work but are deprecated and will show warnings. Please update your dependencies to use the new package names.

### Patch Changes

- Updated dependencies [2e7957d]
  - neon-new@0.14.0

## 0.7.0

Initial release (renamed from `vite-plugin-db`).
