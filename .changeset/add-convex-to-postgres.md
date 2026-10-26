---
"@neon/convex-to-postgres": minor
---

Add `@neon/convex-to-postgres` — migrate a Convex deployment to Neon Postgres. Generates Postgres DDL from a Convex schema (ids and deferrable foreign keys, literal-union `CHECK`s, snake_case identifiers, and Neon Lakebase Search BM25 + `lakebase_ann` vector indexes), and loads a `convex export` snapshot through a jsonb staging table so `v.int64` precision survives a round-trip. A pure, side-effect-free SQL-generation core (`generateDdl`, `generateSeedSql`, …) plus `importConvexExport` for a direct `pg` load.
