# @neon/live-react

React integration for [`@neon/live`](../live). It provides one shared
`RealtimeClient` through context and exposes materialized subscriptions through
`useLiveQuery()`.

> **Status:** Realtime is experimental. Its APIs may change before a stable
> release.

## Install

```bash
npm install @neon/live @neon/live-react react
```

> **Requirements:** Node.js >= 20.19 and React 18 or 19. The core SDK and React
> are peer dependencies, so applications control their installed versions.

## Usage

Create one client for the browser application and provide it near the root:

```tsx
import { createRealtimeClient } from "@neon/live/client";
import { RealtimeProvider } from "@neon/live-react";

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
import type { SealedLiveQuery } from "@neon/live/client";
import { useLiveQuery } from "@neon/live-react";
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

  useEffect(() => utils.onBatch((_changes, batch) => {
    console.debug("Applied transactions", batch.txids);
  }), [utils]);

  if (error) return <p>{error.message}</p>;
  if (data === undefined) return <p>Loading…</p>;

  return (
    <>
      {status === "stale" && <p>Updating…</p>}
      <ul>
        {data.map((message) => <li key={message.id}>{message.body}</li>)}
      </ul>
    </>
  );
}
```

The hook returns `data`, `status`, and `error`, plus stable `utils` for
`getState()`, `getSnapshot()`, `awaitTxId()`, `awaitRows()`, `renew()`, and
lower-level event listeners. Register listeners in an effect. `utils` omits
`unsubscribe()` because React owns cleanup when the component unmounts or its
sealed query changes.

When `refreshQuery` is present, the integration renews before expiry
and keeps retrying through capability expiry and transport outages. Existing
data remains available with status `stale`. Changing the sealed query starts
a new logical query; changing only the refresh callback does not.

For SSR, execute the same query on the server and pass its rows as
`initialData`. React renders them immediately as stale data, and the first
authoritative live-query reset reconciles any intervening changes.

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

**Warning:** `awaitTxId()` resolves when a live batch includes the transaction
ID or when the last successfully applied reset snapshot proves it visible. The
protocol does not currently acknowledge a no-op transaction after
that snapshot. It can resolve only if a later reset proves it visible; because
resets may be infrequent, pass a timeout or avoid waiting when the mutation
endpoint reports that no change was made.

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
- `UseLiveQueryOptions`, `UseLiveQueryResult`, and `UseLiveQueryUtils` are
  exported for reusable component and framework typings.
