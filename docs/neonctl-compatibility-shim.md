# `neonctl` compatibility shim

## Decision

`neon` is the only package that contains the Neon CLI implementation and build
output. `neonctl` is a small compatibility package with:

- one dependency: `"neon": "workspace:*"` (rewritten to the released version by
  `pnpm pack`);
- one executable file that imports the public `neon/cli` entry point;
- the two command names the old package provided, `neonctl` and `neon`, both
  pointing at that file.

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
working directory, and exit behavior.

One file serves both command names. `process.argv[1]` is the link the user
invoked, not the file it resolves to, so the CLI brands its own help from the
command name without the shim passing anything along.

The compatibility package keeps **both** names because the package it replaces
provided both, and things downstream depend on that — see Homebrew below. A
package that dropped `neon` would be a smaller shim that broke its consumers.

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

The standalone binaries are named after the package, so they now ship as
`neon-linux-x64`, `neon-linux-arm64`, `neon-macos-x64`, and `neon-win-x64.exe`
on a `neon@<version>` GitHub release.

The first release must include the coordinated Databricks workflow change that
stops repacking `neonctl` as `neon` and instead treats both as independent
publish targets. After that migration, normal CLI releases use the existing
one-package-per-dispatch flow unchanged.

## Homebrew

`brew install neonctl` installs
[homebrew-core's `neonctl` formula](https://github.com/Homebrew/homebrew-core/blob/main/Formula/n/neonctl.rb),
which is outside this repository: it builds from the npm `neonctl` tarball,
symlinks every executable that package provides, generates completions for
`neonctl` **and** `neon`, and prunes the bundled esbuild out of
`lib/node_modules/neonctl/node_modules` in favor of the `esbuild` formula.
Homebrew's bot bumps it within a day of each npm publish.

Nothing about it changes, and that is the reason the compatibility package keeps
both command names and stays the package Homebrew builds from. Replaying the
formula's install steps against the packed compatibility tarball:

- `npm install` resolves the `neon` dependency, and its transitive dependencies
  hoist into `lib/node_modules/neonctl/node_modules` — the path the formula
  prunes, still holding `esbuild` and `@esbuild`;
- `libexec.glob("bin/*")` yields `neonctl` and `neon`, since both `bin` entries
  belong to the installed package;
- both completions generate, each branded with the name it was invoked as.

The formula cannot simply be repointed at the `neon` package instead:
homebrew-core's `neon` is already the
[neon HTTP/WebDAV library](https://formulae.brew.sh/formula/neon), so `neonctl`
is the name Homebrew has for the Neon CLI regardless of what npm calls it. That
makes the npm `neonctl` package load-bearing rather than vestigial, which is a
second reason to keep it a genuine package instead of deprecating it.

## Compatibility

- `npm install --global neon` — the recommended install; provides `neon`.
- `npm install --global neonctl` — provides `neonctl` and `neon`, exactly as the
  package it replaces did, and additionally downloads `neon`.
- `brew install neonctl` — unchanged, provides both commands.
- `npx neonctl ...` installs/resolves both packages and runs the shim.
- Arguments, standard streams, configuration directory, and exit behavior are
  those of the shared CLI entry point, whichever command name is used.
- The `neon` package itself provides only the `neon` command. Someone who
  installed `neon` and calls `neonctl` needs the `neonctl` package (which is what
  Homebrew installs) or the `neon` command.
- The package versions stay synchronized through the Changesets fixed group.
  `neon-init` relies on this: it compares a globally installed `neonctl --version`
  (which reports the `neon` implementation's version) against
  `npm view neonctl version`, and would prompt for pointless updates if the two
  packages could drift.
