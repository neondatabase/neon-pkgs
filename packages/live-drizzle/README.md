# @neon/live-drizzle

Drizzle ORM adapter for [`@neon/live`](../live). It turns a concrete Drizzle
PostgreSQL select into the parameterized SQL accepted by the Neon Live backend
SDK while preserving Drizzle's inferred result-row type.

> **Status:** Neon Live is experimental. Its APIs may change before a stable
> release.

## Install

```bash
npm install @neon/live @neon/live-drizzle drizzle-orm
```

> **Requirements:** Node.js >= 20.19, `@neon/live` 0.1, and Drizzle ORM 0.45.
> The core SDK and Drizzle are peer dependencies.

## Usage

Create the backend SDK with the Drizzle adapter, then pass a concrete select
builder directly to `authorize()`:

```ts
import { createNeonLive } from "@neon/live/server";
import { drizzleAdapter } from "@neon/live-drizzle";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/neon-http";
import { integer, pgTable, text } from "drizzle-orm/pg-core";

const messages = pgTable("messages", {
  id: integer("id").primaryKey(),
  channelId: text("channel_id").notNull(),
  body: text("body").notNull(),
});

const db = drizzle(process.env.DATABASE_URL!);
const neonLive = createNeonLive({
  secret: process.env.NEON_LIVE_SECRET!,
  db: "app",
  adapter: drizzleAdapter(),
});

const channelId = "general";
const query = db
  .select({ id: messages.id, body: messages.body })
  .from(messages)
  .where(eq(messages.channelId, channelId));

const authorization = await neonLive.authorize({ query });
// LiveQueryAuthorization<{ id: number; body: string }>
```

Authorization performs local encryption and does not execute the query. Keep
this code on the application backend and return the authorization only after
authenticating the caller and checking that they may observe the requested
data.

The adapter uses Drizzle's SQL and driver-ready parameter values. Parameters
use PostgreSQL OID `0`, so PostgreSQL determines their types from the query
context. This supports Drizzle's built-in PostgreSQL encoders without coupling
the adapter to Drizzle's private parameter metadata.

## Result names and aliases

Neon Live receives PostgreSQL result-column names, while Drizzle can map a
different TypeScript key without changing the SQL alias. When a selected key
differs from its database column name, give it an explicit SQL alias matching
the key:

```ts
import { sql } from "drizzle-orm";

const query = db.select({
  messageId: sql<number>`${messages.id}`.as("messageId"),
  body: messages.body,
}).from(messages);
```

The adapter rejects renamed or duplicate result fields that would decode into
the wrong object shape. It currently supports concrete PostgreSQL select
builders from `drizzle-orm` 0.45.x. Raw SQL remains available as an escape
hatch through `rawSql()` from `@neon/live/server`.

## API

`drizzleAdapter()` returns the adapter passed to `createNeonLive({ adapter })`.
It has no database connection of its own and never executes the query during
authorization.
