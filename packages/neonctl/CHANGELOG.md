# neonctl

## 2.38.1

### Patch Changes

- Updated dependencies [2532f9e]
  - neon@2.38.1

## 2.38.0

### Minor Changes

- eda9d82: Make `neon` the package that carries the Neon CLI implementation, and turn `neonctl` into a lightweight compatibility package that depends on `neon` and runs its CLI entry point. `neonctl` keeps providing both the `neonctl` and `neon` commands, so installing it — including via Homebrew — behaves exactly as before, and now also downloads `neon`.

### Patch Changes

- Updated dependencies [eda9d82]
  - neon@2.38.0
