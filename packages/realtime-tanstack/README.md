# @neon/realtime-tanstack

TanStack DB integration for [`@neon/realtime`](../realtime). It consumes raw
live-query events while TanStack DB owns collection materialization and local
reactive queries.

> **Status:** Realtime is experimental. Its APIs may change before a stable
> release.

## Install

```bash
npm install @neon/realtime @neon/realtime-tanstack \
  @tanstack/db @standard-schema/spec
```

> **Requirements:** Node.js >= 20.19, `@neon/realtime` 0.1, and TanStack DB 0.9.
> All three supporting libraries are peer dependencies.

## Usage

Create a collection from a shared Realtime client and a sealed query returned
by the application backend:

```ts
import { createRealtimeClient } from "@neon/realtime/client";
import { realtimeCollectionOptions } from "@neon/realtime-tanstack";
import { createCollection } from "@tanstack/db";

const client = createRealtimeClient({
  url: "wss://live.neon.tech/...",
});
const query = await sealTodos();

export const todos = createCollection(realtimeCollectionOptions({
  id: "todos",
  client,
  query,
  refreshQuery: sealTodos,
  getKey: (todo) => todo.id,
}));
```

`client`, `query`, and `getKey` are required. `getKey` must return a
stable unique string or number for every row. Standard collection options such
as `id`, `schema`, garbage collection, collation, and mutation handlers are
forwarded to TanStack DB.

The integration synchronizes eagerly. It applies each authoritative reset or
live-query publication batch as one TanStack sync transaction. Realtime
`connecting` maps to a loading collection and `live` maps to ready. A stale
subscription keeps its usable collection ready during recovery; terminal errors
put the collection into its error state.

## Optimistic mutations

Use TanStack DB mutation handlers normally. Have the application mutation
endpoint return the PostgreSQL transaction ID captured inside the write
transaction, then explicitly wait for the live query to observe it:

```ts
const todos = createCollection(realtimeCollectionOptions({
  id: "todos",
  client,
  query,
  getKey: (todo) => todo.id,
  onUpdate: async ({ transaction, collection }) => {
    const todo = transaction.mutations[0].modified;
    const response = await fetch(`/api/todos/${todo.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ completed: todo.completed }),
    });
    if (!response.ok) throw new Error("Could not update todo");

    const { txid } = (await response.json()) as { txid: string };
    await collection.utils.awaitTxId(txid);
  },
}));
```

`awaitTxId()` also handles the race where the live batch arrives before the HTTP
response. It resolves after covered row changes enter TanStack DB's causal sync
queue and waits indefinitely by default. Pass an optional timeout in milliseconds
to bound the wait.

`awaitTxId()` does not determine whether a transaction committed, so pass only
the ID of a transaction known to have committed.

For SSR, use TanStack DB's normal `DbClient`, dehydration, and
`HydrationBoundary` APIs with stable collection IDs. The server seeds a
request-scoped collection with the initial rows; the browser hydrates it and
starts ordinary Realtime synchronization. Do not pass `initialData` to
`realtimeCollectionOptions()` because TanStack DB owns collection hydration.

## API

`realtimeCollectionOptions(config)` returns ordinary TanStack DB collection
options with a Realtime-owned `sync` implementation and an additional
`utils.awaitTxId()` method. The package also exports the corresponding config,
options, and utilities types for reusable collection factories.
