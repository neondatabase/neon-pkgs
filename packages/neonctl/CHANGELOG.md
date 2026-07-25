# neonctl

## 2.37.0

### Minor Changes

- Make `neon` the package that carries the Neon CLI implementation, and turn `neonctl` into a lightweight compatibility package that depends on `neon` and runs its CLI entry point. `neonctl` keeps working unchanged; the `neonctl` executable now ships from the `neonctl` package instead of from the CLI implementation package.

### Patch Changes

- Updated dependencies
  - neon@2.37.0
