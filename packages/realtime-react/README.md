# @neon/realtime-react

React integration for [`@neon/realtime`](../realtime). It provides one shared
`RealtimeClient` through context and exposes materialized subscriptions through
`useLiveQuery()`.

> **Status:** Realtime is experimental. Its APIs may change before a stable
> release.

## Install

```bash
npm install @neon/realtime @neon/realtime-react react
```

> **Requirements:** Node.js >= 20.19, `@neon/realtime` 0.2, and React 18 or 19.
> The core SDK and React are peer dependencies, so applications control their
> installed versions.

## Usage

Create one client for the browser application and provide it near the root:

```tsx
import { createRealtimeClient } from "@neon/realtime/client";
import { RealtimeProvider } from "@neon/realtime-react";

const client = createRealtimeClient({
  url: "wss://live.neon.tech/...",
});

export function Root({ children }: { children: React.ReactNode }) {
  return <RealtimeProvider client={client}>{children}</RealtimeProvider>;
}
```

A route loader, Server Component, or parent obtains the sealed query from the
application backend. The hook deliberately does not fetch it:

```tsx
import type { SealedLiveQuery } from "@neon/realtime/client";
import { useLiveQuery } from "@neon/realtime-react";
import { useEffect } from "react";

interface Message {
  id: number;
  body: string;
}

interface MessagesProps {
  channelId: string;
  query: SealedLiveQuery<Message>;
  initialRows?: readonly Message[];
}

export function Messages(props: MessagesProps) {
  const { data, status, error, utils } = useLiveQuery(props.query, {
    initialData: props.initialRows,
    refreshQuery: () => sealMessages(props.channelId),
  });

  useEffect(() => utils.onUpdate((update) => {
    if (update.type === "changes") {
      console.debug("Applied transactions", update.batch.txids);
    }
  }), [utils]);

  if (error) return <p>{error.message}</p>;
  if (data === undefined) return <p>Loading…</p>;

  return (
    <>
      {status !== "live" && <p>Updating…</p>}
      <ul>
        {data.map((message) => <li key={message.id}>{message.body}</li>)}
      </ul>
    </>
  );
}
```

The hook returns `data`, `status`, `error`, and `isPlaceholderData`, plus
stable `utils` for `getState()`, `getSnapshot()`, `awaitTxId()`,
`awaitRows()`, `renew()`, and lower-level event listeners. Register listeners
in an effect. `utils` omits `unsubscribe()` because React owns cleanup when the
component unmounts or its sealed query changes.

`data` preserves the server's ordered result sequence, including incremental
moves. Each publication and completed baseline backlog exposes one atomic
materialized snapshot. Upgrade the core and this adapter together to 0.2.0;
the core requires a server that accepts `neon.realtime.v2`.

The hook infers the row type from the sealed query. `initialData` and
`refreshQuery` must match it; they cannot remove selected columns or widen
their types to make incompatible inputs fit.

When `refreshQuery` is present, the integration renews before expiry
and keeps retrying through capability expiry and transport outages. Existing
data remains available while `stale` indicates that a replacement capability
is being obtained and `connecting` indicates active resubscription or transport
recovery. Changing the sealed query starts a new logical query; changing only
the refresh callback does not. A new logical query has no `data` until its
first result arrives, unless you pass `initialData` or `keepPreviousData`.

### Skipping a query

Pass `null` instead of a sealed query to skip it. Use it while the sealed
query is still being fetched, or when the component has nothing to subscribe
to yet, instead of moving the hook into a separate gate component:

```tsx
// sealedQuery is undefined until the backend returns it.
const { data, status } = useLiveQuery(sealedQuery ?? null);
```

While the query is `null`, the hook opens no subscription and returns an idle
result: `status` is `"closed"`, `error` and `data` are `undefined`, and
`isPlaceholderData` is `false`. It returns the same object on every render, so
it is safe in effect dependencies. `initialData` and `refreshQuery` are
ignored. `utils.getState()` and `utils.getSnapshot()` report the same idle
state, listeners registered through `utils` never run, and `awaitTxId()`,
`awaitRows()`, and `renew()` reject. Passing a sealed query subscribes;
passing `null` again unsubscribes.

### Keeping the previous rows

A new sealed query starts with no rows, so a list empties whenever the query
changes: a growing `LIMIT` on "load more", or the next month in a calendar.
Set `keepPreviousData: true` to keep returning the rows the hook last rendered
until the new query has rows of its own (its first result, or its
`initialData`). `isPlaceholderData` is `true` while those earlier rows are
shown:

```tsx
import { useLiveQuery } from "@neon/realtime-react";
import { useState } from "react";

export function Notifications() {
  const [limit, setLimit] = useState(20);
  // Your hook that fetches a sealed query for this limit from the backend.
  // It returns undefined until that query arrives.
  const sealedQuery = useSealedNotifications(limit);
  const { data = [], isPlaceholderData } = useLiveQuery(sealedQuery ?? null, {
    keepPreviousData: true,
    refreshQuery: () => sealNotifications(limit),
  });

  return (
    <>
      <ul style={{ opacity: isPlaceholderData ? 0.6 : 1 }}>
        {data.map((item) => <li key={item.id}>{item.title}</li>)}
      </ul>
      <button
        disabled={isPlaceholderData}
        onClick={() => setLimit((current) => current + 20)}
      >
        Load more
      </button>
    </>
  );
}
```

The earlier rows are also kept while the query is `null`, as in the example
while the next sealed query is being fetched. That result has `status`
`"closed"` and `isPlaceholderData` `true`. Set `keepPreviousData` to `false`
(it is read on every render) when the earlier rows must not stay on screen, for
example after signing out.

`status` and `error` always describe the current query, so `status` is
`connecting` while the next query loads, and an error from it is reported
alongside the earlier rows. `utils` belongs to the current query too:
`utils.getSnapshot()` has no rows until the next result arrives, and
`awaitRows()` waits for the current query's rows. An empty result counts as
the new query's rows, so `data` becomes `[]`.

### Server-rendered initial data

For SSR, execute the same query on the server and pass its decoded rows as
`initialData`. React renders them immediately with status `connecting`, and the
first authoritative live-query result reconciles any intervening changes.

`initialData` must match the sealed query's live row type and the client's
configured PostgreSQL parsers. HTTP serialization does not change that type:
for example, a query whose rows contain `created_at: Date` still produces `Date`
rows even if a JSON-aware RPC framework types the initial HTTP rows with
`created_at: string`.

Restore those values in application code before calling the hook:

```tsx
// A typed API response: query produces Date rows, initialData has JSON strings.
const initialData = payload.initialData.map((row) => ({
  ...row,
  created_at: new Date(row.created_at),
}));

const { data } = useLiveQuery(payload.query, { initialData });
// data: readonly { id: number; created_at: Date }[] | undefined
```

In this example, passing the serialized rows directly is a type error. No
explicit row annotation or cast is needed for the conversion above. If your
transport already restores dates, pass its rows directly.

Convert before the first render that consumes the rows, not in an effect.
The server render and the browser's initial hydration render must receive
equivalent decoded values. Converting only on the server is insufficient if
the data is subsequently serialized to JSON again. The hook does not perform
this conversion; use your application's serializer or decoder.

### Optimistic mutations

React's `useOptimistic()` can overlay application-defined changes while
Realtime remains the authoritative source. Keep the optimistic Action pending
until the subscription has applied the mutation's PostgreSQL transaction:

```tsx
import { startTransition, useOptimistic } from "react";

const { data = [], utils } = useLiveQuery(sealedQuery);
const [optimisticTodos, setOptimisticTodo] = useOptimistic(
  data,
  (todos, update: { id: string; completed: boolean }) =>
    todos.map((todo) =>
      todo.id === update.id
        ? { ...todo, completed: update.completed }
        : todo,
    ),
);

function setCompleted(id: string, completed: boolean) {
  startTransition(async () => {
    setOptimisticTodo({ id, completed });
    const { txid } = await updateTodo(id, { completed });
    await utils.awaitTxId(txid);
  });
}
```

Express optimistic changes as desired values rather than relative operations
such as `toggle`. This makes them safe when React rebases a still-pending Action
over newer authoritative rows. `awaitTxId()` also handles the race where the
live batch arrives before the mutation response.

`awaitTxId()` does not determine whether a transaction committed, so pass only
the ID of a transaction known to have committed. Use a timeout when the
application needs a bounded wait.

When the mutation endpoint does not return a transaction ID, `awaitRows()` can
keep the optimistic Action pending until the complete materialized result
matches the desired state:

```tsx
await utils.awaitRows(
  (rows) =>
    rows.some(
      (todo) => todo.id === id && todo.completed === completed,
    ),
  10_000,
);
```

The current snapshot is checked first, so include a unique version, timestamp,
or mutation identifier when the predicate must confirm one particular
mutation. Otherwise pre-existing or unrelated data can satisfy it. The timeout
is optional; without one, the promise waits until the rows match or the
subscription closes or enters a terminal error.

## API

- `RealtimeProvider` supplies one existing `RealtimeClient` to descendant
  hooks. It does not fetch sealed queries or own the client's lifetime.
- `useLiveQuery(query, options)` owns one materialized subscription and
  cleans it up when the component unmounts or the sealed query changes.
  Pass `null` as `query` to skip it. `options` accepts `initialData`,
  `refreshQuery`, and `keepPreviousData`.
- `useRealtimeClient()` returns the provider's `RealtimeClient`, to pass to
  `realtimeCollectionOptions()` from `@neon/realtime-tanstack` or to call
  `subscribe()` directly. Subscriptions opened that way are not owned by
  React.
- `UseLiveQueryOptions`, `UseLiveQueryResult`, and `UseLiveQueryUtils` are
  exported for reusable component and framework typings.
