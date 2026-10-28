---
"@neon/convex-to-postgres": minor
---

Add `@neon/convex-to-postgres` — migrate a Convex deployment to Neon Postgres. Generates Postgres DDL from a Convex schema (ids and deferrable foreign keys, literal-union `CHECK`s, snake_case identifiers, and Neon Lakebase Search BM25 + `lakebase_ann` vector indexes), and loads a `convex export` snapshot through a jsonb staging table so `v.int64` precision survives a round-trip. Run it with `npx @neon/convex-to-postgres` and its `schema`, `seed`, and `import` commands: SQL goes to stdout for piping into `psql`, warnings and progress go to stderr, and `seed --split <dir>` writes the load as editable step files (`01-schema.sql` … `04-indexes.sql`) so you can change the schema and still migrate the data. The same functionality is available as a library: a pure, side-effect-free SQL-generation core (`generateDdl`, `generateDataSql`, `generateSeedSql`, …) plus `importConvexExport` for a direct `pg` load.
