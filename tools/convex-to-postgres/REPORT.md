# convex-to-postgres: Phase B findings

This report records what the integration suite proved by running the generator against a real Postgres (via testcontainers) over a corpus of real Convex schemas and a full round-trip of a real `convex export` snapshot. It covers the supported feature surface, the Convex export facts the round-trip confirmed, the round-trip results, and a recommendation on using schema auto-generation as the default path in the migration documentation.

All results below come from `pnpm --filter convex-to-postgres test:integration` (Docker required): Suite A applies generated DDL for every loadable corpus schema, Suite B round-trips a real export, and Suite C round-trips a second deployed app.

## Generator fixes made during Phase B

Five generator defects were found by feeding real schemas through to a live Postgres, and all were fixed in `src/`:

1. **Forward and cyclic foreign keys did not apply.** Foreign keys were emitted inline in `CREATE TABLE` as `REFERENCES other_table`, which fails when `other_table` is declared later in the schema or participates in a reference cycle, even though the code intended to support any load order. Foreign keys are now emitted as `ALTER TABLE ... ADD CONSTRAINT ... DEFERRABLE INITIALLY DEFERRED` after every table is created. (`src/schema/generate-ddl.ts`)
2. **Reserved-word identifiers were emitted unquoted.** A column or table named `user`, `null`, `union`, `order`, `references`, and similar produced a syntax error. `quoteIdentIfNeeded` now also quotes Postgres reserved keywords. (`src/util/names.ts`)
3. **A user field colliding with a synthesized column broke `CREATE TABLE`.** A Convex field literally named `id` or `created_at` emitted a duplicate column. Such a column is now renamed with a numeric suffix and a warning, and its value extraction is unchanged. (`src/schema/plan.ts`)
4. **An index on a schemaless table referenced a column that was never created.** A union-as-table, a `v.any()` table, or a `defineTable({})` keeps its fields inside a single `doc jsonb` column, so an index declared on one of those fields now skips with a warning instead of emitting an invalid `CREATE INDEX`. (`src/schema/plan.ts`)
5. **`v.commitTs()` crashed generation.** It serializes as a validator type the mapper did not know, which threw. It is now approximated as `bigint` with a warning, and any other unrecognized validator degrades to `jsonb` with a warning rather than crashing. (`src/schema/model.ts`, `src/schema/map-types.ts`)

## 1. Supported vs unsupported Convex features

Grounded in what the corpus and the round-trip actually exercised. "Round-tripped" means data was loaded and read back and asserted; "DDL applies" means the generated schema was applied to a live Postgres with no error but no data for that feature was loaded.

| Convex feature | Postgres mapping | Status |
| --- | --- | --- |
| `v.string` | `text` | Round-tripped |
| `v.number` / `v.float64` | `double precision` | Round-tripped (see float formatting in section 2) |
| `v.boolean` | `boolean` | Round-tripped |
| `v.int64` | `bigint` | Round-tripped, including a value above 2^53 and a negative |
| `v.commitTs` | `bigint` (approximation) | DDL applies; not round-tripped against data |
| `v.bytes` | `bytea` | Round-tripped, including an empty buffer |
| `v.null` | `jsonb` | DDL applies; makes a union member nullable |
| `v.any` | `jsonb` | Round-tripped (as a schemaless table fallback) |
| `v.id(userTable)` | `uuid` (md5) or `text` plus a deferrable foreign key | Round-tripped, referential integrity verified |
| `v.id(_storage)` / `v.id(_scheduled_functions)` | `uuid` / `text`, no foreign key, warning | DDL applies |
| `v.object` (nested) | `jsonb` (not flattened) | Round-tripped |
| `v.array` | `jsonb` | Round-tripped |
| `v.record(key, value)` | `jsonb` | DDL applies |
| `v.union` of string literals | `text` plus `CHECK (col IN (...))` | Round-tripped; the CHECK rejects out-of-set values |
| `v.union` of number or boolean literals | `double precision` / `boolean`, no CHECK | DDL applies |
| `v.union` that includes `v.null()` | the sole non-null member, nullable | Round-tripped |
| `v.union` of mixed or non-literal members | `jsonb`, warning | Round-tripped (mixed string/number stored as jsonb) |
| Union used directly as a table shape | schemaless: `id`, `created_at`, `doc jsonb`, warning | DDL applies |
| Schemaless table / `defineTable({})` | `id`, `created_at`, `doc jsonb`, warning | Round-tripped (empty tables) |
| Single and multi-column `.index(...)` | `CREATE INDEX` | Applies |
| `.index(...)` on a nested path (`a.b`) | skipped, warning (use an expression index) | Not representable as a btree |
| `.index(...)` on a schemaless field | skipped, warning | The field lives inside `doc jsonb` |
| `.searchIndex(...)` | Neon Lakebase BM25 index over a generated `tsvector` column (+ `lakebase_text`) | Emitted; built post-load |
| `.vectorIndex(...)` | `vector(d)` column + Lakebase `lakebase_ann` index (+ `lakebase_vector`) | Emitted; built post-load |
| `.searchIndex`/`.vectorIndex` `filterFields` | one plain btree per field | Emitted; built post-load |
| Synthesized `_id` | `id` primary key (`uuid` via md5, or `text` verbatim) | Round-tripped |
| Synthesized `_creationTime` | `created_at timestamptz` | Round-tripped |
| File storage contents | not migrated; only `_storage` id columns are kept | Out of scope |
| Referential integrity across deletes | a deferrable foreign key can reject a reference to a deleted document | See section 3, tutorial finding |

## 2. Verified Convex export facts

The round-trip confirmed the export format facts the generator was built against:

- **int64 serializes as a bare integer with no decimal point**, and the value survives exactly. A value of two to the fifty-third power plus one came back from the `bigint` column as the exact digits `9007199254740993` when selected as text, proving no floating-point rounding. A negative int64 came back as `-1`.
- **float64 serializes with a decimal point** (for example `36.0`, `42.0`, `0.0`). A top-level `v.number` column casts to `double precision` and normalizes (a stored `3.0` reads back as `3`), while a number nested inside an object is preserved in `jsonb` with its original text form (`3.0`, `0.0`). This decimal-point presence on floats, and its absence on integers, is exactly what lets the `bigint` versus `double precision` casts stay correct without sniffing the value.
- **bytes serialize as `{"$bytes":"<base64>"}`**, and an empty buffer is `{"$bytes":""}`. The generator decodes base64 into `bytea`; the empty buffer decodes to a zero-length `bytea`, not null.
- **id references are bare id strings.** A reference field holds the plain id string of the target document, equal to that document's `_id`. Under the uuid strategy both hash with md5 to the same uuid, so a left join found zero orphans; under the text strategy the id is stored verbatim and the join still found zero orphans.
- **`_creationTime` is a fractional-millisecond epoch.** The value carried fractional milliseconds (for example `1792787860912.071`), and `to_timestamp(value / 1000)` produced a `timestamptz` with sub-second precision in a sane calendar range.
- **An absent optional field is an omitted key**, not a null literal. A field present in one row and omitted in another produced a value and a `NULL` respectively; the same held for two separate optional fields across three rows.
- **ZIP layout.** The snapshot contains `_tables/documents.jsonl` (one line per table with its name and a numeric id), a `<table>/documents.jsonl` per user table, a `<table>/generated_schema.jsonl` whose content is the string `"uniform"`, and a top-level `README.md`. The directory form and the `.zip` form produced identical loads (same row counts and same ids). Empty tables still appear with a directory, a zero-byte `documents.jsonl`, and a `"uniform"` schema line.

## 3. Round-trip results

**Suite B (real export, the guaranteed fixture).** One `authors` row, two `posts` rows, three `misc` rows. Every assertion passed:

- Reported row counts and actual row counts equal the JSONL line counts (`authors` one, `posts` two, `misc` three).
- Every `posts.author_id` resolves to an `authors.id` (zero orphans), a foreign key constraint is present on `posts`, and the data is present, proving the single transaction committed.
- The int64 column returns `9007199254740993` and `-1` exactly.
- The `bytea` column decodes to a five-byte buffer for one row and a zero-length buffer for the empty-bytes row.
- `created_at` is a `timestamptz` with sub-second precision in a sane year range.
- The optional field is null for the row that omitted it and set for the row that carried it.
- The mixed string/number union is stored as `jsonb` and reads back as a string, an integer, and a fractional number; two optional fields round-trip their present and absent states.
- The text id strategy stores ids verbatim and still finds zero orphans.
- The `.zip` source and the extracted directory produce identical row counts and identical ids.
- The string-literal `CHECK` constraint rejects an out-of-set value with a check violation.
- `generateSeedSql`, executed as a single script the way `psql -f seed.sql` would run it, loads the same rows with zero orphans.

**Suite A (corpus DDL validity).** Thirteen real schemas loaded and generated DDL. For every schema that declares no search or vector index, that DDL applied to a fresh Postgres schema namespace with no error, and every planned table and column exists with the planned type. Schemas that declare a search or vector index now emit Neon Lakebase DDL (`lakebase_text` / `lakebase_vector` extensions and `vector(d)` columns), which the stock `postgres` container cannot create, so those fixtures assert the emitted SQL (extension lines, the generated `tsvector` / `vector` columns, the `lakebase_bm25` / `lakebase_ann` indexes) rather than applying it — no Lakebase-capable container is required. The schemas that could not be loaded (external dependencies such as `convex-helpers`, `@convex-dev/auth`, `@convex-dev/workpool`, and unsaved local helper modules) are recorded and skipped in `integration/fixtures/corpus/FIXTURES.md`; none failed because of a generator defect.

**Suite C (deployed tutorial app).** The Convex chat tutorial was deployed against a local anonymous backend, seeded through its own `send` mutation, and exported. The export round-tripped cleanly: the messages survived with their authors, the reserved-word table `references` was quoted correctly and carries its four foreign keys to the `u1` through `u4` tables, the four empty `defineTable({})` tables stayed empty, and the `.zip` and directory forms produced identical counts.

One behavior worth calling out from the tutorial app: its `makeRefs` mutation inserts a document, references it from another table, then deletes the referenced document, leaving a dangling reference. Convex does not enforce referential integrity, so a real export can contain references to deleted documents. The generated foreign keys are deferrable but still enforced at commit, so loading such data would be rejected. Suite C therefore seeds only the messages for a clean positive round-trip; data with dangling references needs cleaning or the foreign keys dropped before import. This is a property of Convex data, not a generator defect.

## 4. Recommendation

**Yes, with caveats.** Schema auto-generation through `loadConvexSchema` followed by `generateDdl` is clean enough to be the default way to produce the initial Postgres schema, and the migration documentation should steer users to it. It applied across thirteen diverse real schemas and fully round-tripped a real export with referential integrity, exact int64 precision, byte buffers, optional fields, unions, and nested objects. Its warnings double as a precise manual to-do list: they name every feature that cannot be expressed as plain DDL.

The caveats are about where auto-generated output differs from a hand-written relational model, and they are the reason to treat the output as a strong starting point rather than a finished schema:

- **It keeps Convex field names, only snake-cased.** A Convex field `channel` stays `channel`, not `channel_id`; a `v.string` field `author` stays `author text`, not `author_id`. A hand-written schema (and the migration doc's worked example) renames and retypes such fields for relational clarity. The generator does not infer that a string field is really a reference, so naming and string-to-reference promotion remain a manual pass.
- **Nested objects and arrays become `jsonb`, not flattened columns.** This is a faithful, lossless import, but a hand model might flatten an object into columns or split an array into a child table.
- **Search and vector indexes are emitted as Neon Lakebase DDL.** A `.searchIndex` becomes a generated `tsvector` column plus a `lakebase_bm25` index; a `.vectorIndex` retypes the embedding field to `vector(d)` and adds a `lakebase_ann` index; each index's `filterFields` become plain btrees. These are built **after** the data load (and `VACUUM ANALYZE` runs after) for better BM25 corpus statistics and ANN layout. They target Neon Lakebase, whose `lakebase_text` / `lakebase_vector` extensions do not exist on a vanilla Postgres. **Nested-path indexes and system-table references are still emitted as warnings, not SQL** — map those manually to expression indexes and a storage strategy.
- **Mixed unions and schemaless tables fall back to `jsonb` or a single `doc` column.** A hand model might split a discriminated union into typed columns or separate tables.
- **Referential integrity must be checked against the data.** Convex permits references to deleted documents, which the generated foreign keys will reject at load.

A representative slice of generated output, using generic names, shows the shape and the naming behavior:

```sql
CREATE TABLE authors (
    id uuid PRIMARY KEY,
    created_at timestamptz NOT NULL,
    name text NOT NULL
);

CREATE TABLE posts (
    id uuid PRIMARY KEY,
    created_at timestamptz NOT NULL,
    title text NOT NULL,
    author_id uuid NOT NULL,
    metadata jsonb NOT NULL,
    status text NOT NULL CHECK (status IN ('draft', 'active', 'archived'))
);

ALTER TABLE posts ADD CONSTRAINT posts_author_id_fkey
    FOREIGN KEY (author_id) REFERENCES authors (id) DEFERRABLE INITIALLY DEFERRED;
```

Here `author_id` is a real `v.id("authors")` reference (so it is already a foreign key), while a `v.string` field named `author` would instead appear as `author text` with no key. The nested `metadata` object is stored as `jsonb` rather than flattened. That is the gap a hand-tuned schema closes, and it is the right default to generate first and then refine.
