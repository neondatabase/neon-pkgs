# @neon/live-kysely

Kysely adapter for [`@neon/live`](../live). It turns a concrete Kysely select
builder into the parameterized PostgreSQL query accepted by the Neon Live
backend SDK while preserving Kysely's inferred result-row type.

> **Status:** Neon Live is experimental. Its APIs may change before a stable
> release.

## Install

```bash
npm install @neon/live @neon/live-kysely kysely
```

> **Requirements:** Node.js >= 20.19, `@neon/live` 0.1, and Kysely 0.28.17 or
> 0.29.x. Both `@neon/live` and Kysely are peer dependencies. Kysely 0.29
> itself requires Node.js >= 22.

## Usage

Create the backend SDK with the Kysely adapter, then pass a concrete select
builder directly to `seal()`:

```ts
import { createNeonLive } from "@neon/live/server";
import { kyselyAdapter } from "@neon/live-kysely";
import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";

interface Database {
  messages: {
    id: number;
    channel_id: string;
    body: string;
  };
}

const db = new Kysely<Database>({
  dialect: new PostgresDialect({
    pool: new Pool({
      connectionString: process.env.DATABASE_URL,
    }),
  }),
});

const neonLive = createNeonLive({
  secret: process.env.NEON_LIVE_SECRET!,
  db: "app",
  adapter: kyselyAdapter(),
});

const channelId = "general";
const query = db
  .selectFrom("messages")
  .select(["id", "body"])
  .where("channel_id", "=", channelId);

const sealedQuery = await neonLive.seal({ query });
// SealedLiveQuery<{ id: number; body: string }>
```

Sealing performs local encryption and does not execute the query or open a
database connection. The adapter runs Kysely's query-transforming plugins,
then compiles the resulting operation tree using Kysely's PostgreSQL compiler.
Keep sealing on the application backend and authorize the caller before
returning the sealed query.

## Parameters

Kysely leaves parameter encoding to its database driver. Neon Live instead
encodes Kysely's raw values using the familiar node-postgres rules. Strings,
numbers, booleans, bigints, `null`, `undefined`, `Date`, byte arrays,
PostgreSQL arrays, JSON objects, and values implementing `toPostgres()` work
directly.

Use `sql.val(array)` when a PostgreSQL array must be one bound value in a
Kysely expression; a bare array in APIs that accept lists may instead become
multiple SQL expressions.

Use `pgParam` as an occasional escape hatch when a value needs an explicit
PostgreSQL text encoding or OID. Pass the wrapper through a Kysely `sql`
expression because an ordinary typed comparison expects the column's
JavaScript input type:

```ts
import { pgParam } from "@neon/live/server";
import { sql } from "kysely";

const query = db
  .selectFrom("documents")
  .select(["id", "title"])
  .where(
    sql<boolean>`embedding = ${pgParam.text("vector", "[1,2,3]")}`,
  );
```

All existing `pgParam` helpers are accepted. Most applications will not need
them because a selected column or typed comparison gives PostgreSQL enough
context to infer the parameter type.

## Result names and plugins

Neon Live builds row objects from PostgreSQL's result-column names. Use SQL
aliases when a result key should differ from its column name, and ensure every
result name is unique:

```ts
const query = db
  .selectFrom("messages")
  .select(["id as messageId", "body"]);
```

Query-transforming Kysely plugins run normally. Result-transforming plugins
are not supported because Neon Live does not execute queries through Kysely's
driver and therefore cannot call `transformResult()`. In particular,
`CamelCasePlugin` would make Kysely infer camel-case keys while PostgreSQL
still returns snake-case names. Define live-query result keys that already
match their PostgreSQL names instead.

## API

`kyselyAdapter()` returns the adapter passed to
`createNeonLive({ adapter })`. It has no database connection of its own and
never executes the query during sealing.
