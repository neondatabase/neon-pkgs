---
"neon": patch
---

`neon skills status` and the daily outdated-skills warning no longer report freshly installed skills as outdated. skills 1.8 writes `skills-lock.json` version 2 with a new content hash, and the check now recognizes it alongside the older one, so it agrees with `neon skills update`.

`neon init`, `neon config init`, and `neon functions new` now install `@neon/config`, `@neon/env`, and template dependencies at the root of a pnpm workspace (with `-w`) or a Yarn Classic workspace (with `-W`), instead of failing with `ERR_PNPM_ADDING_TO_ROOT`. The printed retry command includes the flag too.

When `npx` is not on PATH, `neon plugins`, `neon skills`, and `neon init` say that npm is missing and name the command that installs it (for example `pnpm add -g npm`), instead of asking you to install Node.js.
