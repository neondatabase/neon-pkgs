# `neonctl` compatibility shim

## Decision

`neon` is the only package that contains the Neon CLI implementation and build
output. `neonctl` is a small compatibility package with:

- one dependency: `"neon": "workspace:*"` (rewritten to the released version by
  `pnpm pack`);
- one executable: `neonctl`;
- one executable file that imports the public `neon/cli` entry point.

The two packages are a Changesets fixed group, so every CLI release republishes
both at the same version. The external Databricks release workflow publishes
`neon` first and `neonctl` second.

## Why this design

### One implementation, two command names

The primary package owns `src`, `dist`, tests, dependencies, standalone binary
builds, and the `neon` executable. The compatibility package contains no copied
CLI code or build artifacts. Its executable imports `neon/cli` in-process:

```js
#!/usr/bin/env node

await import("neon/cli");
```

An in-process import preserves arguments, standard streams, signals, current
working directory, and exit behavior. It also lets the primary CLI inspect
`process.argv[1]` and render `neonctl` in help output when invoked through the
compatibility command.

### npm download accounting

npm counts successful package-tarball responses, not command invocations. Running
an already installed `neonctl` cannot create an npm download. Installing
`neonctl`, including through `npx`/`npm exec` when it is not cached, resolves and
downloads its `neon` dependency. Those uncached tarball fetches count toward the
`neon` package's download total as well as `neonctl`'s.

Registry, package-manager, and mirror caches can avoid a network fetch, so no
package layout can guarantee one recorded download for every command execution.
The dependency-based shim is the direct way to attribute new `neonctl`
installations to `neon` without runtime network requests or duplicated code.

## Alternatives considered

### Publish the same tarball under both names

This is the previous behavior. It is simple, but duplicates the complete CLI
tarball and its dependency metadata. Installing `neonctl` does not resolve
`neon`, so the primary package receives no download from that installation.

### Spawn the `neon` executable

The shim could resolve the dependency's executable and start a child process.
That adds process startup, signal forwarding, platform-specific executable
resolution, and exit-code propagation. It provides no benefit over importing a
purpose-built public CLI entry point.

### Point `bin` directly into the dependency

npm's `bin` field describes executable files owned by the package and links those
files during installation. A relative path into a dependency is coupled to an
installer's `node_modules` layout and breaks with hoisting differences. The shim
therefore owns a three-line executable and imports the dependency through Node's
package resolution.

### Download or install `neon` at runtime

Runtime installation would make every invocation slower and network-dependent,
mutate the user's environment, complicate offline use, and introduce version
drift. Dependencies must be resolved by the package manager at install time.

### npm package aliases

Dependency aliases change the local dependency name; they do not turn the
published `neonctl` package into a registry redirect. A real `neonctl` package is
still required to own the legacy command.

## Release flow

The release mechanism does not change:

1. A feature PR carries a Changeset.
2. The release skill runs `pnpm changeset version` and lands the version/changelog
   PR on `main`.
3. The Databricks
   `databricks/secure-public-registry-releases-eng/.github/workflows/neon-pkgs.yml`
   workflow is manually dispatched once per package.
4. Dispatch `package=neon` first. This publishes the implementation package,
   builds standalone binaries, and creates the `neon@<version>` GitHub release.
5. Verify `npm view neon version`.
6. Dispatch `package=neonctl`. Its packed `workspace:*` dependency points at the
   same `neon` version, which is now available to npm consumers.
7. Verify `npm view neonctl version` and
   `npm view neonctl dependencies.neon`.

The first release must include the coordinated Databricks workflow change that
stops repacking `neonctl` as `neon` and instead treats both as independent
publish targets. After that migration, normal CLI releases use the existing
one-package-per-dispatch flow unchanged.

## Compatibility

- `npm install --global neon` installs the primary `neon` command.
- `npm install --global neonctl` installs the `neonctl` shim and its `neon`
  dependency.
- `npx neonctl ...` installs/resolves both packages and runs the shim.
- Existing `neonctl` arguments, standard streams, configuration directory, and
  exit behavior are preserved by the shared CLI entry point.
- The `neon` package no longer installs a `neonctl` executable of its own; that
  command is owned by the `neonctl` package. Anyone who installed `neon` and
  called `neonctl` installs `neonctl` instead.
- The package versions stay synchronized through the Changesets fixed group.
