# Vendored upstream PostgreSQL regression fixtures

These are verbatim copies of PostgreSQL's `src/test/regress` SQL scripts and
their expected outputs, used as ground truth by the psql-conformance harness
(`tests/psql-conformance/regress.spec.ts`).

## Why vendored

The harness previously fetched these files from
`raw.githubusercontent.com/postgres/postgres/<tag>/…` at test bootstrap. That
requires public-internet egress at test time, which the Databricks protected
CI runner group does not allow (it can only reach the JFrog npm mirror). To let
conformance run in that environment, the fixtures are vendored here instead.

## Layout

```
upstream/<PG_TAG>/sql/<case>.sql        # regress input script
upstream/<PG_TAG>/expected/<case>.out   # expected output (the oracle)
```

`<PG_TAG>` matches `PG_TAG` in `tests/psql-conformance/POSTGRES_REF`. `<case>`
is one of `psql`, `psql_crosstab`, `psql_pipeline`.

## Updating (bumping the PG pin)

1. Change `PG_TAG` / `PG_COMMIT` / `PG_IMAGE*` in `POSTGRES_REF`.
2. Re-fetch the six files for the new tag into `upstream/<NEW_TAG>/`:

   ```
   BASE=https://raw.githubusercontent.com/postgres/postgres/<NEW_TAG>/src/test/regress
   for c in psql psql_crosstab psql_pipeline; do
     curl -sS "$BASE/sql/$c.sql"      -o upstream/<NEW_TAG>/sql/$c.sql
     curl -sS "$BASE/expected/$c.out" -o upstream/<NEW_TAG>/expected/$c.out
   done
   ```

3. Optionally delete the previous tag's directory.

The files are byte-for-byte upstream; do not hand-edit them.

## License

These files are part of PostgreSQL and are distributed under the PostgreSQL
License. Copyright (c) 1996-2025, PostgreSQL Global Development Group;
Portions Copyright (c) 1994, Regents of the University of California. See
https://www.postgresql.org/about/licence/.
