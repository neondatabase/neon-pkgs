---
"neon": patch
---

`neon init`, `neon config init`, and `neon functions new` no longer fail with `spawn ENOENT` in a project that has lockfiles from several package managers, such as `bun.lockb` next to `package-lock.json`, when one of those package managers is not installed. They now install with one that is on PATH, unless `package.json` pins one with `packageManager`, or the project is a pnpm workspace or was installed by pnpm.
