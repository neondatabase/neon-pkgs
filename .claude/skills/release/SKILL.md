---
name: release
description: Cut version bumps + changelogs for maintained packages in this monorepo. Detects which packages changed since their published npm version (git-vs-npm), reconciles against pending Changesets, runs `changeset version` to bump + cascade dependents, and opens a PR. This repo only produces version-bump commits — the actual npm publish happens externally (private mirror). Use when asked to "release", "cut a release", "bump versions", or "check what needs releasing".
---

# Release: version bumps + changelogs

## What a "release" means in this repo

This repo does **not** publish to npm. Publishing happens from a **private mirror**
(see `chore: disable npm provenance (published from a private mirror)`). Here a release
is only a **version-bump + CHANGELOG commit on `main`**, landed via a PR. The mirror picks
it up and publishes.

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
- `local version > npm version` (already bumped in `main`, not yet published — e.g. the mirror is behind), or
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

Remember this repo only produces the version bump — **nothing here pushes to npm; the external
private mirror publishes on merge.** So report two distinct things, and say explicitly that the
listed packages still need that external publish:

1. **Bumped in this run** — `name: old → new` for each package `changeset version` touched (mark
   which are dependent-cascade bumps). These get published once the mirror picks up the merge.
2. **Publish backlog** — every maintained package whose `main` version is now *ahead of* npm
   latest (`npm view <pkg> version`). This is what is actually awaiting publish: it includes the
   packages bumped in this run **plus** any from earlier merges the mirror hasn't published yet
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
reviews, or post comments unless explicitly asked. The private-mirror CI publishes on merge.

## Gotchas

- **CHANGELOG version gaps** can happen when a prior PR bumped `package.json` directly without a
  changeset (e.g. `ai-sdk-provider` jumped 0.2.0 → 0.4.0 in the log, skipping 0.3.0). Surface it;
  don't try to backfill.
- `changeset version` writes to `/dev/tty`; the `Opening /dev/tty failed` warning is harmless.
- Never invoke `biome`/`changeset` binaries directly — go through `pnpm` scripts / `pnpm changeset`.
