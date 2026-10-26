# Corpus fixtures

Real Convex `schema.ts` files collected from the official Convex GitHub org, used
by `corpus.integration.test.ts` (Suite A) to prove the generator produces valid,
applying Postgres DDL across the Convex feature matrix. Each file is pinned to an
immutable commit SHA. These are third-party fixtures: read only, do not execute
their surrounding apps.

The org formerly at `github.com/get-convex` is now `github.com/convex`; the URLs
below use the current `convex/*` paths.

## Vendored fixtures

| Dir | Source repo | Commit | Repo path | Features exercised |
| --- | --- | --- | --- | --- |
| `convex-demos__typescript` | convex/convex-demos | `2fac21e360bfcceae6065096f1b81480bd8c6fd5` | `typescript/convex/schema.ts` | Baseline scalars (`v.string`). No indexes. |
| `convex-demos__relational-data-modeling` | convex/convex-demos | `2fac21e360bfcceae6065096f1b81480bd8c6fd5` | `relational-data-modeling/convex/schema.ts` | `v.id(...)` cross-table reference becomes a foreign key; single-column index. |
| `convex-demos__search` | convex/convex-demos | `2fac21e360bfcceae6065096f1b81480bd8c6fd5` | `search/convex/schema.ts` | `.searchIndex` emitted as a Lakebase BM25 index over a generated `tsvector` column. Emit-only (Lakebase extensions are not in the stock container). |
| `convex-demos__vector-search` | convex/convex-demos | `2fac21e360bfcceae6065096f1b81480bd8c6fd5` | `vector-search/convex/schema.ts` | `.vectorIndex` emitted as a `vector(d)` column + Lakebase `lakebase_ann` index; `filterFields` as btrees; `v.optional(v.id(...))` nullable foreign key. Emit-only. |
| `convex-demos__presence-typing-indicator` | convex/convex-demos | `2fac21e360bfcceae6065096f1b81480bd8c6fd5` | `presence-typing-indicator/convex/schema.ts` | `v.any()` to jsonb; two multi-column indexes; reserved-word column `user`. |
| `convex-demos__system-tables` | convex/convex-demos | `2fac21e360bfcceae6065096f1b81480bd8c6fd5` | `system-tables/convex/schema.ts` | `v.id("_storage")` system-table reference: column kept, no foreign key, warning. |
| `templates__template-bare` | convex/templates | `208423929bf864135946938a9d53b990bd9104a1` | `template-bare/convex/schema.ts` | Nested `v.object` to jsonb; `v.array(v.number())`; schema-level `schemaValidation` option. |
| `persistent-text-streaming__src-component` | convex/persistent-text-streaming | `1d92fe7c634e7da4e28b73a8f700d82056948606` | `src/component/schema.ts` | Literal-enum union to `text` + `CHECK IN`; `v.id` foreign key; index on the union column. |
| `crons__src-component` | convex/crons | `545b53b4b2672f1775a96c95f1744455968c639e` | `src/component/schema.ts` | `v.record(v.string(), v.any())` to jsonb; discriminated union to jsonb; `v.optional`; `v.id("_scheduled_functions")` system references. |
| `migrations__src-component` | convex/migrations | `dc87b0354f2df2bfd7d6f938b0866401d974eddc` | `src/component/schema.ts` | `v.union(v.string(), v.null())` nullable `text`; `v.boolean`; `v.optional(v.id(...))`; two indexes. |
| `geospatial__src-component` | convex/geospatial | `5d5c3054e3c80ca0dfc6acdd342d93477e0c4ea4` | `src/component/schema.ts` | `v.record(string, union(primitive, array(primitive)))` to jsonb; nested `v.object` point; three-column index; `v.int64` via the shared `primitive` validator. Local helpers `types.ts` and `lib/primitive.ts` vendored alongside so the file resolves. |
| `aggregate__src-component` | convex/aggregate | `93874650281ad758b842e76d3f0c7e0a54a3c1f3` | `src/component/schema.ts` | `v.commitTs()` approximated as `bigint`; `v.int64`; discriminated and value unions; `v.array(v.id(...))` self-reference; **forward and cyclic foreign keys** (`btree` references `btreeNode`, declared later). |
| `convex-backend__static-codegen-ts` | convex/convex-backend | `868554ba04ea5fe1b4c4b88136146865eeee3432` | `npm-packages/private-demos/static-codegen-ts/convex/schema.ts` | Kitchen sink: every scalar incl. `v.bytes`; reserved-word columns `null` and `union`; a user field named `id` that collides with the primary key; `defineTable({})` empty table; union-as-table; `v.record` with string and id keys; nested-path indexes skipped; an index on a schemaless table skipped; `.searchIndex` and `.vectorIndex` emitted as Lakebase BM25/ANN DDL (emit-only). |

## Deliberately skipped (do not load from source text alone)

| Dir | Reason |
| --- | --- |
| `convex-demos__sessions` | Imports `vSessionId` from `convex-helpers/server/sessions`; `convex-helpers` is not an installed dependency. |
| `templates__template-nextjs-convexauth` | Spreads `...authTables` from `@convex-dev/auth/server`; the table set lives in that package, not in the file. |
| `workflow__src-component` | Imports `@convex-dev/workpool`, `convex-helpers/validators`, and a local `./logging.js` that was not part of the corpus. |
| `workpool__src-component` | Imports a local `./shared.js` (`fnType`, `vConfig`, ...) that was not part of the corpus. |
| `convex-backend__system-udfs` | Imports local `./tableDefs/*` modules that were not part of the corpus. |

The matrix the skipped files would have added (external/branded validators, auth
table sets, `v.record(string, any)`, discriminated unions, `v.int64`, system-table
ids, nested objects) is already covered by the vendored set above.
