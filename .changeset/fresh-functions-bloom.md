---
"neon": minor
---

Add function templates to the CLI: `neon functions new <template>` scaffolds a
Neon Function from the folder-backed Neon Function Registry, and `neon functions
templates list` browses what is available.

The registry is a shadcn-style directory: a root `registry.json` discovery index
points at each `<template>/template.json`, and each template folder holds its own
metadata (a `layout`, pinned dependencies, environment, and operations) plus the
source modules it references under `functions/`. Source code is never inlined in
JSON — the CLI fetches the index, each `template.json`, and each referenced file
only from the reviewed Neon registry origin, enforcing same-origin/base-path
containment (no arbitrary URLs, `..`, escaping redirects, duplicate paths, or
oversized files/counts) and running no hooks. The reviewed remote registry is
authoritative: a remote/local entry overrides the bundled copy of the same id,
so registry updates ship without a CLI release. Built-in `basic`, `resend`, and
`rest-api` templates ship compiled into the CLI only as the offline fallback
(used when the registry is unreachable). `pnpm check:registry` validates the
index, templates, file references, schemas, and built-in sync, and is wired into
the CLI build/lint.

A template's `layout` decides the shape. `router` generates one Neon Function
whose `index.ts` router dispatches by URL path (each operation has a `route`;
unmatched paths 404). `separate` copies each selected operation module and
deploys each as its own Neon Function under its own `slug` — no aggregate router;
`--name` picks the local folder while the provider slugs are the remote/`neon.ts`
keys. Selection resolves flags first (`--operation` is repeatable,
`--all-operations` takes every one, the two conflict, unknown ids list the valid
ones). With no flags, a non-interactive run (`-y`, CI, no TTY, or structured
output) uses the recommended set; an interactive run first asks whether to use
the recommended operations, and "customize" opens a Space-toggle multiselect with
the recommended ones preselected (keep at least one). The bundled Resend template
(`separate`) exposes `send-email`, `send-batch`, `get-email` (recommended), and
`cancel-email`; `rest-api` (`router`) is a dependency-free routed REST API.
Structured `--output json`/`yaml` includes `layout`, the selected operations
(with `routes` for router), and the resulting function-to-slug/source mapping.

Required environment variables are no longer scaffolded into per-function
`.env.example` files. `neon functions new` inspects the project root's `.env`/
`.env.local`, never overwrites an existing value, and writes any missing keys to
a single project dotenv file (prompted with a masked prompt in a terminal, or a
blank `KEY=` placeholder non-interactively — ambient `process.env` secrets are
never copied to disk). It gitignores the chosen file and refuses to write to a
git-tracked one. `--no-env` opts out and `--env-to <path>` picks the destination
(inside the project root). Structured output reports the env file path and
variable names only, never values.

By default `neon functions new` now also registers the scaffolded function in a
`neon.ts` policy so `neon deploy` picks it up — still fully offline (a local file
edit, no auth or API call). It searches upward for a supported config filename
(stopping at the nearest Git/project boundary, nearest wins), or uses `--config
<path>`, and creates a minimal `./neon.ts` (just the `@neon/config/v1` import and a
`functions` block declaring this function) when none exists. Editing is conservative:
it only touches a static `export default
defineConfig({ … })` object literal whose `defineConfig` comes from `@neon/config`,
inserting `<slug>: { name, source, env }` while preserving all other policy text and
formatting and writing atomically. A `separate`-layout scaffold registers every
selected operation as its own entry in one atomic write, detecting all conflicts
before writing (same-source entries no-op). Anything it cannot prove safe (spreads,
computed keys, dynamic/imported configs, `preview.functions`, aliased `defineConfig`,
ambiguous or out-of-project targets) is left untouched with a pasteable fragment
printed instead. `--no-add-to-config` opts out; `--add-to-config` forces it; a
same-slug conflict needs `--force` or `--name`. Structured output gains `config` and
`neon_ts_fragment` fields.
