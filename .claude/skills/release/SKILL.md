---
name: release
description: Cut version bumps + changelogs for maintained packages in this monorepo. Detects which packages changed since their published npm version (git-vs-npm), reconciles against pending Changesets, runs `changeset version` to bump + cascade dependents, and opens a PR. This repo only produces version-bump commits; the npm publish is then triggered manually from a separate Databricks releases repo. Use when asked to "release", "cut a release", "bump versions", or "check what needs releasing".
---

# Release: version bumps + changelogs

## What a "release" means in this repo

This repo does **not** publish to npm from its own CI. A release is **two steps**:

1. **Bump** — land a **version-bump + CHANGELOG commit on `main`** via a PR (the work this skill does).
2. **Publish** — after that PR merges, **manually trigger** the npm publish workflow in the separate
   Databricks releases repo (step 7):
   <https://github.com/databricks/secure-public-registry-releases-eng/actions/workflows/neon-pkgs.yml>

Nothing here publishes automatically — a merged bump just sits on `main` (and ahead of npm) until
someone runs that workflow. Provenance is disabled because publishing runs from there, not from this
repo (see `chore: disable npm provenance (published from a private mirror)`).

Versioning is driven by **[Changesets](https://github.com/changesets/changesets)**
(`.changeset/config.json`, per-package `CHANGELOG.md`). `AGENTS.md` mentions an automated
"Version Packages" PR bot — that is **stale**; those workflows were removed. The bump is run
by hand and committed (see history: `release pending changesets`, `bump patch versions…`).

`changeset version` is the engine. Git-vs-npm is the **safety net** that catches packages
which changed but have no changeset (a forgotten release).

## Which packages are "maintained"

**Each package's own `README.md` is the source of truth for its status** — don't hardcode a list.
A package is *deprecated* if its `README.md` opens with a deprecation banner (convention: a first
heading containing `DEPRECATED`, e.g. `# ⚠️ DEPRECATED: <name>`); otherwise it's *maintained*. The
top-level `README.md` lists only maintained packages, as a convenience index.

So enumerate maintained packages as: every `packages/*/` with a `package.json` that is published
(`"private"` absent or false) and whose `README.md` has **no** `DEPRECATED` banner.

Folders under `packages/` with only `dist/`/`node_modules/` and no `package.json` are build
artifacts — ignore them.

### The CLI package (`packages/cli`)

`packages/cli` is the primary `neon` package. `packages/neonctl` is a lightweight compatibility
command that depends on `neon` and imports its public `neon/cli` entry point. They are a Changesets
fixed group, so changing either package bumps and republishes both at the same version. A few things
differ from the rest of the repo:

- It uses its own **build** toolchain (`tsc` → `dist`, `@yao-pkg/pkg` binaries) rather than tsdown,
  but is linted/formatted by Biome like every other package (via a `packages/cli/**` override in
  `biome.json`) and is covered by root `biome ci`.
- **`neonctl` is a thin compatibility package** that depends on `neon` (`workspace:*`). The
  Changesets fixed group keeps the package versions synchronized; a changeset for either package
  bumps both.
- **Publishing the CLI also ships standalone binaries**: the external `neon-pkgs.yml` workflow
  cross-compiles `@yao-pkg/pkg` binaries when publishing `neon` and attaches them to a GitHub
  release on `neondatabase/neon-pkgs` (tag `neon@<version>`). Nothing to do at bump time; just be
  aware the primary CLI publish does more than npm.

## Procedure

### 1. Detect what needs a release (git-vs-npm)

For each maintained package:

```bash
# npm latest (published)
npm view <pkg-name> version
# local
node -p "require('./packages/<dir>/package.json').version"
# source commits to the folder since the commit that set the npm version
git log --oneline <npm-release-commit>..HEAD -- packages/<dir>
```

A package **needs a release** if either:
- `local version > npm version` (already bumped in `main`, not yet published — e.g. the publish workflow hasn't been run yet), or
- there are **source** commits to its folder after its last npm release.

**Ignore packaging/CI-only commits** (e.g. `publishConfig.provenance` flips, lockfile-only,
test-config-only changes) — they don't warrant a user-facing release.

### 2. Reconcile against pending changesets

```bash
ls .changeset/*.md   # ignore README.md
```

Each changeset's frontmatter lists `"<pkg>": <major|minor|patch>`. Cross-check:
- A package flagged in step 1 **with** a pending changeset → covered.
- Flagged **without** a changeset → the gap. Create one (`.changeset/<slug>.md`) choosing the
  bump type from the change (breaking → major; new behavior → minor; fix/internal → patch).
  Write a user-facing summary.
- A pending changeset for a package the detector did **not** flag → investigate (already-bumped
  or duplicate); surface it, don't silently proceed.

### 3. Bump

```bash
pnpm changeset version
```

This consumes the `.md` files, rewrites `package.json` versions, appends to each `CHANGELOG.md`,
and — because all internal deps are `workspace:*` with `updateInternalDependencies: "patch"` —
**recursively patch-bumps dependents** of any released package. No manual cascade needed.

> Internal deps use `workspace:*`, so dependents never pin a version. The only reason to bump a
> dependent is to republish it against the new dependency — which is exactly what this step does.

### 4. Verify

```bash
git status --short              # expect: deleted .md, modified package.json + CHANGELOG.md
pnpm lint:ci                    # biome checks formatting (incl. package.json) — must pass
```

`workspace:*` deps mean `pnpm-lock.yaml` usually does not change. If it does, commit it too.

### 5. Report the release set + the publish backlog

Remember this repo only produces the version bump — **nothing here pushes to npm; the publish is a
separate manual workflow trigger (step 7).** So report two distinct things, and say explicitly that
the listed packages still need that external publish:

1. **Bumped in this run** — `name: old → new` for each package `changeset version` touched (mark
   which are dependent-cascade bumps). These get published once the bump PR merges **and** the
   publish workflow (step 7) runs.
2. **Publish backlog** — every maintained package whose `main` version is now *ahead of* npm
   latest (`npm view <pkg> version`). This is what is actually awaiting publish: it includes the
   packages bumped in this run **plus** any from earlier merges not yet published
   (e.g. `main` at 0.4.0 while npm is at 0.1.1). Report it as `name: npm <published> → main <pending>`.

Don't claim a package is "released" — at this stage it's *bumped and awaiting the external npm publish*.

### 6. Open the PR

```bash
git checkout -b release-bumps   # if not already on a release branch
git add -A
git commit -m "chore: release pending changesets"
git push -u origin HEAD
gh pr create --title "chore: release pending changesets" --body "<summary>"
```

The PR body should list the bumped packages and versions. Do **not** assign reviewers, request
reviews, or post comments unless explicitly asked.

### 7. Publish to npm (after the bump PR merges)

The bump PR only lands versions on `main`. The actual npm publish is a **manual** GitHub Actions run
in the Databricks releases repo — it is **not** triggered by merging here:

<https://github.com/databricks/secure-public-registry-releases-eng/actions/workflows/neon-pkgs.yml>

Trigger it once the bump is on `main`, via the **Run workflow** button in that UI, or per package:

```bash
gh workflow run neon-pkgs.yml --repo databricks/secure-public-registry-releases-eng \
  -f package=<package-name> -f ref=main
```

> ⚠️ **`-f package=` is mandatory and the workflow input defaults to `dry-run`.** The workflow
> publishes **exactly the one package** you select — there is **no "publish everything ahead of
> npm" mode**. Dispatching with no `-f package=` (or `package=dry-run`) runs a smoke-test that
> **publishes nothing**: the run still goes green and shows a "Publish …" step (that's
> `npm publish --dry-run`), so it *looks* successful while npm stays on the old version. So for a
> multi-package release, **dispatch this once per bumped package** (e.g. `@neon/env`, then
> `@neon/functions`, then `@neon/ai-sdk-provider`). Valid `package` values are the
> choices in the workflow's `workflow_dispatch` input (each maintained package, plus `dry-run`).

**Publish order: leaf deps first, the CLI last.** The build packs from source (every internal dep
is `workspace:*`), so ordering doesn't affect whether a run *succeeds* — but for npm consumers to
resolve cleanly, publish a dependency before its dependents:
`@neon/config` → `@neon/config-runtime` / `@neon/env` → `neon` → `neonctl`.
Publishing `neon` also ships the standalone binaries and GitHub release; publish the compatibility
package only after `npm view neon version` confirms the matching primary package.

**Homebrew needs nothing from you.** `brew install neonctl` is a homebrew-core formula that builds
from the npm `neonctl` tarball, and Homebrew's bot bumps it within a day of each publish. The
compatibility package deliberately keeps both the `neonctl` and `neon` commands so the formula keeps
working untouched — see [`docs/neonctl-compatibility-shim.md`](../../../docs/neonctl-compatibility-shim.md)
before changing its `bin` map.

After each run succeeds, confirm with `npm view <pkg> version` — if it still shows the old version,
you ran a dry-run (missing/`dry-run` `package` input); re-dispatch with the real `-f package=<name>`.
This requires access to that repo — if you don't have it, hand the publish backlog list to someone
who does.

## Gotchas

- **The publish workflow defaults to `dry-run` and publishes ONE package per run.** Always pass
  `-f package=<name>` (and `-f ref=main`), once per bumped package. A `dry-run` (or input-less)
  dispatch goes green and prints a "Publish …" step but lands nothing on npm — verify with
  `npm view <pkg> version`, not the green check.
- **Never pin an internal package to a published version.** `packages/cli` pinned `neon-init`
  (since folded into `packages/cli/src/init`) that
  way through 2.39.0, and `changeset version` rewriting the pin without touching `pnpm-lock.yaml`
  broke `--frozen-lockfile` for the whole workspace — every CI job and every publish dispatch —
  with no way to repair it until the new `neon-init` was published from a throwaway ref. Every
  internal dep is `workspace:*` now; keep it that way. `pnpm pack` substitutes the real version at
  publish time, so nothing about the tarball depends on the pin.
- **CHANGELOG version gaps** can happen when a prior PR bumped `package.json` directly without a
  changeset (e.g. `ai-sdk-provider` jumped 0.2.0 → 0.4.0 in the log, skipping 0.3.0). Surface it;
  don't try to backfill.
- `changeset version` writes to `/dev/tty`; the `Opening /dev/tty failed` warning is harmless.
- Never invoke `biome`/`changeset` binaries directly — go through `pnpm` scripts / `pnpm changeset`.
