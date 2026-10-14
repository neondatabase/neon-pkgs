# Vendored: `@supabase/postgres-meta`

A pruned, in-tree copy of the introspection portion of [supabase/postgres-meta](https://github.com/supabase/postgres-meta).

| | |
|---|---|
| Source | https://github.com/supabase/postgres-meta |
| Pinned tag | `v0.93.1` |
| Pinned commit | `dc50199ca163b32ba4bdfa601dd3a9076ed2b640` |
| Copied on | 2026-04-30 |
| License | Apache-2.0 — see [`./LICENSE`](./LICENSE) |
| Upstream license | Apache-2.0, copyright (c) Supabase Inc. (note: upstream `package.json` declares `"license": "MIT"`, but the LICENSE file shipped in the upstream tree is Apache-2.0; we ship the file verbatim and treat the sub-tree as Apache-2.0 to stay safe) |

## Why we vendor instead of depending on it

Upstream ships the introspection library and a Fastify HTTP server in a single
npm tarball, dragging in a chain of vulnerable transitive dependencies (Fastify
≤ 4.x CVE chain, Sentry's heavy node SDK, `pgsql-parser`, `prettier-plugin-sql`,
`pino`, `swagger`, `fastify-metrics`, …) every time a downstream consumer of
`@neondatabase/neon-js` runs `npm install`.

`pnpm` overrides cannot fix this for our consumers — overrides only apply when
*they* install transitively from us, and would not propagate through their own
overrides. Vendoring the ~1% of postgres-meta we actually use lets us drop
the entire HTTP server subtree (and its CVE surface) from the published tarball.

## What we vendor

Only the pieces the `neon-js gen-types` CLI uses:

- `lib/PostgresMeta.ts` and the per-introspector classes (`PostgresMetaTables`,
  `PostgresMetaColumns`, …).
- `lib/db.ts` (pg pool init), `lib/types.ts`, `lib/helpers.ts`, `lib/constants.ts`.
- `lib/generators.ts` — the `getGeneratorMetadata()` driver.
- `lib/sql/*.ts` — the introspection SQL strings.
- `templates/typescript.ts` — the TypeScript codegen template (`apply()`).
- `LICENSE` — full upstream MIT license text.

## What we deliberately did **not** vendor

- `src/server/**` (Fastify routes, Sentry init, swagger, pino, fastify-metrics,
  admin routes, crypto secret loaders).
- `src/server/templates/go.ts`, `swift.ts` — neon-js only generates TypeScript.
- `src/lib/Parser.ts` — pulls `pgsql-parser` and `prettier-plugin-sql`. It only
  exposes `parse`/`deparse`/`format` on `PostgresMeta`, none of which the CLI
  uses. Removed from the vendored `PostgresMeta` class.
- All test files.

## Modifications applied

- **Removed `@sentry/node` calls** from `lib/db.ts`. The `Sentry.startSpan(...)`
  wrappers are pure tracing; the CLI does not initialise a Sentry SDK so they
  were no-ops anyway. Replaced each wrapped block with the inner callback body.
- **Stripped the `RESULT_SIZE_EXCEEDED` branch** from `lib/db.ts`. That branch
  is specific to `npm:@supabase/pg@0.0.3`'s libpq stream-error patches; we use
  upstream `pg@^8` which does not surface that error code.
- **Switched from `npm:@supabase/pg@0.0.3` to upstream `pg@^8`** as the
  PostgreSQL driver. The Supabase fork only exists for libpq result-size limits
  the CLI does not need.
- **Removed `@sinclair/typebox` runtime dependency** from `lib/types.ts`. The
  upstream file declared every `Postgres*` shape twice — once as a typebox
  `Type.Object(...)` schema (used by Fastify route validators we are not
  vendoring) and once via `Static<typeof …>`. We dropped the schema constants
  and rewrote the `Postgres*` types as plain TypeScript interfaces / unions.
- **Removed `Parser` import + `parse`/`deparse`/`format` fields** from
  `lib/PostgresMeta.ts` (see "What we deliberately did not vendor").
- **Re-pointed `templates/typescript.ts`'s `'../../lib/index.js'` import** to
  `'../lib/index.js'` to fit our flatter directory layout, and added a slim
  `lib/index.ts` re-export that lists only the types the template needs.
- **Added a slim `constants.ts`** containing only `GENERATE_TYPES_DEFAULT_SCHEMA`,
  `VALID_FUNCTION_ARGS_MODE`, `VALID_UNNAMED_FUNCTION_ARG_TYPES`, the three
  values pulled from upstream's `src/server/constants.ts`. The upstream file is
  not vendored because everything else in it is server-side.

Each vendored `.ts` file carries a top-of-file header listing the upstream
SHA and any per-file modifications.

## How to update

1. Bump `Pinned tag` and `Pinned commit` above to the new upstream release.
2. Re-fetch the file list (see the table in `Modifications applied` above)
   from the new tag.
3. Re-apply the modifications listed above. The git history of this directory
   is the canonical record of what changed and why.
4. Run `pnpm --filter @neondatabase/neon-js typecheck` and `pnpm test`.
5. Update the `Copied on` date.
6. Bump per-file headers' tag/commit/date.

## License notes

Upstream's `package.json` declares MIT, but the actual `LICENSE` file shipped
in the upstream tree (and copied verbatim here) is Apache-2.0. To stay on the
strictly safer side we treat the vendored sub-tree as Apache-2.0:

- Per-file headers include `SPDX-License-Identifier: Apache-2.0`.
- Each file lists the modifications made by Neon (Apache-2.0 §4(b)).
- The LICENSE file is shipped verbatim in this directory (Apache-2.0 §4(a)).
- No NOTICE file exists upstream, so none is required here (Apache-2.0 §4(d)).

The rest of `@neondatabase/neon-js` is also Apache-2.0, so license compatibility
is trivial.
