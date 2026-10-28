# @neon/convex-to-postgres

Migrate a [Convex](https://convex.dev) deployment to [Neon](https://neon.com)
Postgres. It does two jobs:

1. **Schema generation.** Parse a Convex schema and emit Postgres DDL (`CREATE
   TABLE` + `CREATE INDEX`, including Neon Lakebase Search indexes) as raw SQL.
2. **Data transform and import.** Turn a `convex export` snapshot into Postgres
   rows and load them, preserving numeric precision that a JavaScript
   `JSON.parse` would destroy.

Both jobs run from the command line with `npx @neon/convex-to-postgres` (see
[CLI](#cli)) or from code as a library.

The library's pure core (`parseExportedSchema`, `generateDdl`,
`generateStagingDdl`, `generateTransformSql`) takes data and returns SQL
strings. It reads no files, no environment, and never prints. The I/O entry
points (`loadConvexSchema`, `generateDataSql`, `generateSeedSql`,
`importConvexExport`) layer file, zip, and database access on top.

## Install

The CLI needs no install: run it with `npx`. To use the library:

```bash
npm install @neon/convex-to-postgres
```

> **Requirements:** Node.js >= 20.19. The generated search and vector DDL targets
> a Neon Lakebase branch — it relies on the `lakebase_text` / `lakebase_vector`
> extensions — while the rest of the output is portable Postgres.

## CLI

```bash
npx @neon/convex-to-postgres <schema | seed | import> [options]
```

Run it from your Convex project root. Every command reads `./convex/schema.ts`
unless you pass `--schema <path>`. The file is evaluated, so run it where the
project's dependencies (including `convex`) are installed. SQL goes to stdout,
so it pipes straight into `psql`. Warnings and progress go to stderr.

Start with a snapshot of your deployment:

```bash
npx convex export --path snapshot.zip
```

### Migrate in one step

```bash
npx @neon/convex-to-postgres import --export snapshot.zip --apply-schema \
  --database-url "$DATABASE_URL"
```

`import` creates the tables (`--apply-schema`), loads every document in one
transaction, then builds the search/vector indexes and runs `VACUUM ANALYZE`.
`--database-url` defaults to `DATABASE_URL`. Without `--apply-schema`, the tables
must already exist.

### Review the schema, then load

```bash
npx @neon/convex-to-postgres schema > schema.sql
npx @neon/convex-to-postgres seed --export snapshot.zip > seed.sql

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f schema.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f seed.sql
```

The warnings `schema` prints are the things to check by hand: a dropped foreign
key, a mixed-type union stored as `jsonb`, a skipped index. `seed` writes one
self-contained script for the tables exactly as `schema` generated them. To
change those tables, use `--split`.

### Edit the schema and still migrate the data (`--split`)

```bash
npx @neon/convex-to-postgres seed --export snapshot.zip --split migration
```

| File | What it does | Edit it? |
| --- | --- | --- |
| `01-schema.sql` | Extensions, `CREATE TABLE`, foreign keys, btree indexes | Yes: rename, retype, flatten |
| `02-load.sql` | Staging tables `_convex_<table>(doc jsonb)` and every raw document, in one transaction | No |
| `03-transform.sql` | `INSERT INTO <table> (...) SELECT ... FROM _convex_<table>`, then drops the staging tables | Yes: match your schema edits |
| `04-indexes.sql` | Search/vector indexes, then `VACUUM ANALYZE`. Only written when the schema has search or vector indexes | Rarely |

This works because the staging load does not depend on the target schema. Every
original document sits in `_convex_<table>.doc`, and only `03-transform.sql` is
shaped by the schema. A schema edit is therefore one matching edit to the
transform. To rename `author` to `author_name`, change the column in
`01-schema.sql` and in the transform's column list; the `doc->>'author'`
expression stays. A retype is a different cast, and flattening a nested object
is a new column read with `doc->'meta'->>'field'`.

Run the files in order:

```bash
for f in migration/*.sql; do psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$f" || break; done
```

`--split` refuses to overwrite files from an earlier run, because they may hold
your edits. Pass `--force` to regenerate them.

Convex does not enforce references, so a real export can contain an id whose
target row was deleted. The deferred foreign keys reject it when the transform
commits, and the error's `detail` line names the key.

### Commands and options

| Command | Required | Optional |
| --- | --- | --- |
| `schema` | | `--schema <path>`, `--out <file>` |
| `seed` | `--export <zip-or-dir>` | `--schema <path>`, `--out <file>`, `--split <dir>`, `--force` |
| `import` | `--export <zip-or-dir>`, and `--database-url <url>` or `DATABASE_URL` | `--schema <path>`, `--apply-schema` |

The generation options below apply to all three commands. Pass the same ones to
every command so table names, column names, and types line up between files.

| Flag | Library option | Default |
| --- | --- | --- |
| `--id-strategy uuid\|text` | `idStrategy` | `uuid` |
| `--no-snake-case` | `snakeCase: false` | snake_case on |
| `--no-check-constraints` | `checkConstraints: false` | `CHECK`s on |
| `--search-language <config>` | `searchLanguage` | `english` |
| `--vector-ops <opclass>` | `vectorOps` | `vector_cosine_ops` |
| `--search-k1 <number>` | `searchK1` | `1.2` |
| `--search-b <number>` | `searchB` | `0.75` |
| `--max-ann-dimensions <n>` | `maxAnnDimensions` | no cap |

Every command takes `--help`. A command exits `0` on success and `1` on any
failure, with a message on stderr that names the flag to fix.

The rest of this README covers the library and the mapping rules both
interfaces share.

## Job 1: schema generation

The CLI's `schema` command does this. From code, point the loader at a Convex
`schema.ts`, or hand it the JSON from `SchemaDefinition.export()`, and get DDL
back.

```ts
import { generateDdl, loadConvexSchema } from "@neon/convex-to-postgres";

const schema = await loadConvexSchema("./convex/schema.ts");
const { sql, warnings } = generateDdl(schema, { idStrategy: "uuid" });

console.log(sql);
for (const warning of warnings) console.warn(warning);
```

`generateDdl` returns `{ sql, warnings }`. Warnings cover anything that could not
be represented faithfully: a foreign key dropped because its target is outside
the generated schema, an index on a nested path, or a vector index skipped by
`maxAnnDimensions`.
They are collected and returned, never thrown, so a caller can print a report and
still use the SQL.

Example output for a two-table schema (`users`, `messages` with
`authorId: v.id("users")`):

```sql
CREATE TABLE users (
    id uuid PRIMARY KEY,
    created_at timestamptz NOT NULL,
    name text NOT NULL
);

CREATE TABLE messages (
    id uuid PRIMARY KEY,
    created_at timestamptz NOT NULL,
    author_id uuid NOT NULL REFERENCES users (id) DEFERRABLE INITIALLY DEFERRED,
    body text NOT NULL
);

CREATE INDEX messages_by_author ON messages (author_id);
```

### Type mapping

Every column is read out of a staged `doc jsonb` value. The transform expression
below is the SQL that produces each column's value (`<f>` is the original Convex
field name).

| Convex validator | Postgres type | Transform expression |
| --- | --- | --- |
| `v.string()` | `text` | `doc->>'<f>'` |
| `v.number()` (Float64) | `double precision` | `(doc->>'<f>')::double precision` |
| `v.boolean()` | `boolean` | `(doc->>'<f>')::boolean` |
| `v.int64()` (serialized as `bigint`) | `bigint` | `(doc->>'<f>')::bigint` |
| `v.bytes()` | `bytea` | `decode(doc->'<f>'->>'$bytes', 'base64')` |
| `v.id('t')` | `uuid` or `text` (see below) | `md5(doc->>'<f>')::uuid` or `doc->>'<f>'` |
| `v.object(...)` | `jsonb` | `doc->'<f>'` |
| `v.array(...)` | `jsonb` | `doc->'<f>'` |
| `v.record(...)` | `jsonb` | `doc->'<f>'` |
| `v.any()` | `jsonb` | `doc->'<f>'` |
| `v.null()` | `jsonb` | `doc->'<f>'` |
| `v.literal(x)` | scalar type of `x` | per the scalar type |
| `v.union(...literals)` | scalar type (plus `CHECK` for strings) | per the scalar type |

`v.object`, `v.array`, `v.record`, `v.any`, and `v.null` all map to `jsonb`
because Postgres has no narrower portable type for them. The single-arrow
accessor (`doc->'<f>'`) keeps the nested structure as `jsonb`; the double-arrow
accessor (`doc->>'<f>'`) extracts a scalar as text for casting.

The two synthesized columns on every table:

| Convex field | Postgres column | Transform expression |
| --- | --- | --- |
| `_id` | `id` (primary key) | `md5(doc->>'_id')::uuid` or `doc->>'_id'` |
| `_creationTime` | `created_at timestamptz NOT NULL` | `to_timestamp((doc->>'_creationTime')::double precision / 1000)` |

Convex stores `_creationTime` as a fractional-millisecond epoch, so the transform
divides by 1000 to hand `to_timestamp` seconds.

### Id strategy: `uuid` (default) or `text`

A Convex `_id` is an opaque, roughly 32-character string. How it becomes a
Postgres key is controlled by `idStrategy`:

- **`"uuid"` (default).** The `id` column is `uuid` and its value is
  `md5(doc->>'_id')::uuid`. A `v.id(...)` reference is hashed the exact same way
  (`md5(doc->>'<ref>')::uuid`), so a reference string lands on the same uuid as
  the target row's `_id`. Foreign keys resolve with no lookup table and no second
  pass. `md5(text)` returns 32 hex characters, which is exactly what the uuid
  parser accepts, so this needs no extension.
- **`"text"`.** The `id` column is `text` and holds the Convex id verbatim;
  references are stored verbatim too.

### Foreign keys

A `v.id('t')` becomes a foreign-key column. Constraints are emitted
`DEFERRABLE INITIALLY DEFERRED`, so a single-transaction load can insert tables
in any order, including cycles and self-references.

A `REFERENCES` clause is emitted **only** when the target table is part of the
generated schema. A reference to a Convex system table (`_storage`,
`_scheduled_functions`, ...) or any table not in the schema yields a correctly
typed column with no `REFERENCES` clause, plus a warning.

### Unions and literals

- A union whose members are all literals of the same JavaScript scalar type maps
  to that scalar's Postgres type. String-literal unions additionally get a
  `CHECK (col IN ('a', 'b', ...))` constraint by default; set
  `checkConstraints: false` to omit it.
- A union that includes `v.null()` makes the column nullable and maps on the
  remaining member(s).
- Any other union (mixed scalar types, or non-literal members) maps to `jsonb`
  with a warning.
- A lone `v.literal(x)` maps to the Postgres type of `x`.

### Optionality

`v.optional(...)` is not a wrapper node in the export; it appears as
`optional: true` on the field. An optional field produces a nullable column (no
`NOT NULL`); a non-optional field gets `NOT NULL`. An absent optional key reads
back as SQL `NULL` automatically, because `->>` / `->` on a missing key yields
`NULL`.

### Column and table naming

With `snakeCase: true` (the default), Convex names are fully normalized to clean,
unquoted snake_case Postgres identifiers. Normalization splits camelCase and
acronym boundaries, lowercases, collapses every run of other characters
(dashes, dots, spaces, repeated underscores) to a single `_`, trims leading and
trailing underscores, and prefixes a `_` when the result would start with a
digit. So:

- `authorId` becomes the column `author_id` and `userProfiles` becomes the table
  `user_profiles` (camelCase);
- `my-field`, `a.b`, and `foo bar` become `my_field`, `a_b`, and `foo_bar`
  (kebab, dotted, spaced);
- `2fa` becomes `_2fa` (leading digit).

The transform still reads the original Convex key (`doc->>'my-field'`), so
renaming the column is safe. With `snakeCase: false`, names are kept verbatim and
double-quoted where Postgres would otherwise fold them to lowercase.

The naming is idiomatic, so a generated column can differ slightly from a
hand-written schema. A field named `channel` stays `channel`; it is **not**
renamed to `channel_id` even when it holds a `v.id(...)` reference. Only its type
(`uuid` / `text`) and foreign key change.

### Indexes

`.index('name', ['a', 'b'])` becomes
`CREATE INDEX <table>_name ON <table> (a, b)`, with each field mapped through the
same column-name transform. Convex appends an implicit trailing `_creationTime`
to every index at the backend; it is not present in the export, so it is not
emitted here.

An index on a nested field path (`"a.b"`) is skipped with a warning, because the
leaf type is ambiguous. Create an expression index by hand if you need one.

### Search and vector indexes (Neon Lakebase)

A `.searchIndex(...)` and a `.vectorIndex(...)` are emitted as real
[Neon Lakebase](https://neon.com) search DDL, not warnings. These use Lakebase's
native extensions, so the output targets a Neon Lakebase branch — a vanilla
Postgres does not ship `lakebase_text` / `lakebase_vector`.

- **Search index -> Lakebase BM25.** The searched text field gets a companion
  STORED generated column `<field>_tsv tsvector GENERATED ALWAYS AS
  (to_tsvector('<searchLanguage>', <field>)) STORED`, and a
  `CREATE INDEX ... USING lakebase_bm25 (<field>_tsv) WITH (k1 = <searchK1>, b =
  <searchB>)` is built over it. The defaults `k1 = 1.2`, `b = 0.75` are
  Lakebase's own. Query it with `to_bm25query(...)` and the `<@>` operator.
- **Vector index -> `vector(d)` + Lakebase ANN.** The embedding field is retyped
  from `jsonb` to pgvector's `vector(<dimensions>)`, populated from the staged
  document as `(doc->'<field>')::text::vector` (pgvector parses the array's text
  form), and a `CREATE INDEX ... USING lakebase_ann (<field> <vectorOps>)` is
  built over it. `vectorOps` defaults to `vector_cosine_ops` (cosine distance,
  the `<=>` operator). Lakebase picks the ANN list count automatically, so no
  `lists` is passed.
- **`filterFields`** on either index each become a plain btree on the resolved
  column (deduplicated, so a field filtered by two indexes gets one btree).
- The required `CREATE EXTENSION IF NOT EXISTS lakebase_vector CASCADE;` (pgvector
  arrives via `CASCADE`) and `CREATE EXTENSION IF NOT EXISTS lakebase_text;` lines
  are prepended to the schema DDL, each only when the schema actually uses that
  feature. A schema with neither emits no extension lines at all.

**These indexes are built *after* the data load, not in the schema DDL.**
`generateDdl` emits the extensions, the `CREATE TABLE`s (including the generated
`tsvector` and `vector` columns), and the plain btree indexes. The BM25/ANN
indexes and their filter-field btrees come from a separate `generateIndexDdl`
call, which `importConvexExport` runs after the load (followed by
`VACUUM ANALYZE`), and which `generateSeedSql` appends after its `COMMIT`.
Indexing after the bulk load gives BM25 accurate corpus statistics and ANN a
well-tuned layout; building them first works too, just less well tuned. `VACUUM`
cannot run inside a transaction, which is the other reason it is separate.

Set `maxAnnDimensions` to cap which embeddings get an ANN index: when a vector
index's `dimensions` exceed it, the column is still typed `vector(d)` but the ANN
index is skipped with a warning. The default is no cap.

### Schemaless tables

A table with no declared field shape (schemaless, or a `v.any()` document type)
falls back to `id`, `created_at`, and a single `doc jsonb` column that holds the
whole document. A warning is recorded. The focus of this tool is declared
schemas; a schemaless table is loaded whole rather than column-mapped.

## Job 2: data transform and import

A `convex export` snapshot is a zip (or an extracted directory) containing
`<table>/documents.jsonl`, one JSON document per line.

### Why documents are never parsed in JavaScript

`JSON.parse` collapses the `v.int64` vs `v.number` distinction and rounds any
integer above 2^53. So the loader never parses a document number in JavaScript.
Instead it:

1. Creates a `jsonb` staging table per source table
   (`_convex_<table>(doc jsonb NOT NULL)`).
2. Loads each **raw** JSONL line into it unchanged, as a `jsonb` literal (via a
   parameterized `$1::jsonb` insert when importing, or an embedded literal when
   generating a seed script). Postgres parses the JSON, and its `jsonb` numeric
   type is arbitrary-precision, so a value like `9007199254740993` survives
   exactly.
3. Runs one `INSERT INTO <table> (...) SELECT <mapped expressions> FROM
   _convex_<table>` per table. The per-column casts, driven by the declared
   schema, resolve int64 vs float64 correctly from `jsonb` without sniffing the
   decimal point.
4. Drops the staging tables.

### Generate a seed script

The CLI's `seed` command does this. `generateSeedSql` reads an extracted export
directory and returns one self-contained SQL string: staging DDL, the raw rows
as `jsonb` literals, the typed transform, and the staging drop, all wrapped in
one transaction with deferred foreign keys. Apply the schema DDL first, then run
the seed:

```ts
import { generateDdl, generateSeedSql, loadConvexSchema } from "@neon/convex-to-postgres";
import { writeFileSync } from "node:fs";

const schema = await loadConvexSchema("./convex/schema.ts");

writeFileSync("schema.sql", generateDdl(schema).sql);
writeFileSync("seed.sql", generateSeedSql(schema, "./convex-export"));
```

```bash
psql "postgres://user:password@host/dbname" -f schema.sql
psql "postgres://user:password@host/dbname" -f seed.sql
```

`generateDataSql` returns just the load half (staging tables plus the raw rows,
with no transaction or transform), which is what `seed --split` writes to
`02-load.sql`. Pair it with `generateTransformSql` and `generateStagingDropSql`
to run a hand-edited transform.

### Import programmatically

The CLI's `import` command does this. `importConvexExport` loads an export (a
directory or a `.zip`) through `pg`, inside one transaction, and returns the
per-table row counts. Pass either a `connectionString` (a `pg.Client` is created
and closed internally) or your own `client`. Set `applySchema: true` to run the
generated DDL first.

```ts
import { importConvexExport, loadConvexSchema } from "@neon/convex-to-postgres";

const schema = await loadConvexSchema("./convex/schema.ts");

const result = await importConvexExport({
  schema,
  source: "./convex-export.zip",
  connectionString: "postgres://user:password@host/dbname",
  applySchema: true,
  idStrategy: "uuid",
  log: (message) => console.log(message),
});

console.log(result.tables); // { users: 128, messages: 4096, ... }
for (const warning of result.warnings) console.warn(warning);
```

The `log` callback is optional and defaults to a no-op. The core never writes to
stdout on its own.

## Supported vs unsupported

**Supported:** all scalar validators, ids and foreign keys (both strategies),
nested objects / arrays / records / `any` / `null` as `jsonb`, optional fields,
literals, literal unions (with optional `CHECK`), nullable unions, btree indexes
on top-level fields, schemaless tables (as a single `doc jsonb` column), and
Neon Lakebase **search indexes** (BM25 over a generated `tsvector` column) and
**vector indexes** (`vector(d)` column + a `lakebase_ann` index), with their
`filterFields` as btrees. The search/vector indexes and their filter btrees are
built after the data load (see the section above); the generated SQL targets a
Neon Lakebase branch, since it relies on the `lakebase_text` / `lakebase_vector`
extensions.

**Out of scope for generated DDL (warned, not emitted):**

- **Indexes on nested field paths.** Create an expression index by hand.
- **Foreign keys to tables outside the generated schema** (Convex system tables,
  or tables not exported). The column is still typed; only the `REFERENCES`
  clause is dropped.

## API

| Export | Kind | Description |
| --- | --- | --- |
| `parseExportedSchema(input)` | pure | Parse `SchemaDefinition.export()` JSON (string or object) into a `ConvexSchema`. |
| `loadConvexSchema(path)` | I/O | Load a `schema.ts` with jiti, call `.export()`, and parse it. |
| `generateDdl(schema, options?)` | pure | `{ sql, warnings }`: extensions, `CREATE TABLE`, FKs, and plain btree indexes (pre-load). |
| `generateIndexDdl(schema, options?)` | pure | Post-load `CREATE INDEX` for Lakebase BM25/ANN and search/vector filter btrees; `""` when none. |
| `generateStagingDdl(schema, options?)` | pure | `CREATE TABLE _convex_<t>(doc jsonb NOT NULL)` per table. |
| `generateStagingDropSql(schema, options?)` | pure | `DROP TABLE` for every staging table. |
| `generateTransformSql(schema, options?)` | pure | `INSERT ... SELECT` from staging into the typed tables. |
| `generateDataSql(schema, exportDir, options?)` | reads fs | Staging DDL plus raw jsonb inserts: the load half of the seed script. |
| `generateSeedSql(schema, exportDir, options?)` | reads fs | One self-contained seed script. |
| `importConvexExport(options)` | pg + fs | Load an export (dir or `.zip`) in one transaction; returns row counts. |
| `openExportSource(source)` | fs | Low-level reader over a directory or `.zip` export. |
| `planSchema(schema, options?)` | pure | The resolved Postgres plan shared by the generators. |

`GenerateOptions`: `idStrategy` (`"uuid"` default), `snakeCase` (`true` default),
`checkConstraints` (`true` default), and for Lakebase search/vector:
`searchLanguage` (`"english"` default), `vectorOps` (`"vector_cosine_ops"`
default), `searchK1` (`1.2` default), `searchB` (`0.75` default), and
`maxAnnDimensions` (`undefined` default — no cap).
