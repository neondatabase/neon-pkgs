# @neon/live-tanstack

TanStack DB integration for [`@neon/live`](../live). It consumes raw Neon Live
events while TanStack DB owns collection materialization and local reactive
queries.

> **Status:** Neon Live is experimental. Its APIs may change before a stable
> release.

## Install

```bash
npm install @neon/live @neon/live-tanstack @tanstack/db @standard-schema/spec
```

> **Requirements:** Node.js >= 20.19, `@neon/live` 0.1, and TanStack DB 0.9.
> All three supporting libraries are peer dependencies.

## Usage

Create a collection from a shared Neon Live client and an authorization returned
by the application backend:

```ts
import { createNeonLiveClient } from "@neon/live/client";
import { neonLiveCollectionOptions } from "@neon/live-tanstack";
import { createCollection } from "@tanstack/db";

const client = createNeonLiveClient({
  url: "wss://live.neon.tech/...",
});
const authorization = await authorizeTodos();

export const todos = createCollection(neonLiveCollectionOptions({
  id: "todos",
  client,
  authorization,
  refreshAuthorization: authorizeTodos,
  getKey: (todo) => todo.id,
}));
```

`client`, `authorization`, and `getKey` are required. `getKey` must return a
stable unique string or number for every row. Standard collection options such
as `id`, `schema`, garbage collection, collation, and mutation handlers are
forwarded to TanStack DB.

The integration synchronizes eagerly. It applies each authoritative reset or
Neon Live publication batch as one TanStack sync transaction. Neon Live
`connecting` maps to a loading collection and `live` maps to ready. A stale
subscription keeps its usable collection ready during recovery; terminal errors
put the collection into its error state.

## Optimistic mutations

Use TanStack DB mutation handlers normally. Have the application mutation
endpoint return the PostgreSQL transaction ID captured inside the write
transaction, then explicitly wait for Neon Live to observe it:

```ts
const todos = createCollection(neonLiveCollectionOptions({
  id: "todos",
  client,
  authorization,
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
response. It resolves once the batch has entered TanStack DB's causal sync queue
and rejects if its timeout elapses.

For SSR, use TanStack DB's normal `DbClient`, dehydration, and
`HydrationBoundary` APIs with stable collection IDs. The server seeds a
request-scoped collection with the initial rows; the browser hydrates it and
starts ordinary Neon Live synchronization. Do not pass `initialData` to
`neonLiveCollectionOptions()` because TanStack DB owns collection hydration.

## API

`neonLiveCollectionOptions(config)` returns ordinary TanStack DB collection
options with a Neon Live-owned `sync` implementation and an additional
`utils.awaitTxId()` method. The package also exports the corresponding config,
options, and utilities types for reusable collection factories.
