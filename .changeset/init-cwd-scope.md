---
"neon": major
"@neon/env": minor
---

`neon.ts` and the default `.env` / `.env.local` now come from one project directory: the directory holding the `.neon` in use (the nearest one at or above cwd, or `--context-file`), or cwd when there is none. A `neon.ts` above that directory no longer applies; pass `--config <path>` to use another file. `neon init` always sets up the current directory and creates a `package.json` there before installing `@neon/config` and `@neon/env`.

Migrating:

- A `neon.ts` at a repo root with no `.neon` beside it is no longer found from sub-directories: run `neon link` at the root, or pass `--config`.
- With a root `.neon`, a sub-directory's own `neon.ts` is no longer used: move it next to `.neon`, or pass `--config`.
- Running `env pull` from a sub-directory of a linked project now writes the project directory's `.env.local`; pass `--file` to keep writing elsewhere.
- `neon-env` finds `.neon` past a nested `.git`, the same way `neon` does.
