# @neon/live-react

React integration for [`@neon/live`](../live). It provides one shared
`NeonLiveClient` through context and exposes materialized subscriptions through
`useLiveQuery()`.

> **Status:** Neon Live is experimental. Its APIs may change before a stable
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
import { createNeonLiveClient } from "@neon/live/client";
import { NeonLiveProvider } from "@neon/live-react";

const client = createNeonLiveClient({
  url: "wss://live.neon.tech/...",
});

export function Root({ children }: { children: React.ReactNode }) {
  return <NeonLiveProvider client={client}>{children}</NeonLiveProvider>;
}
```

A route loader, Server Component, or parent obtains the authorization from the
application backend. The hook deliberately does not fetch it:

```tsx
import type { LiveQueryAuthorization } from "@neon/live/client";
import { useLiveQuery } from "@neon/live-react";
import { useEffect } from "react";

interface Message {
  id: number;
  body: string;
}

interface MessagesProps {
  channelId: string;
  authorization: LiveQueryAuthorization<Message>;
  initialRows?: readonly Message[];
}

export function Messages(props: MessagesProps) {
  const { data, status, error, utils } = useLiveQuery(props.authorization, {
    initialData: props.initialRows,
    refreshAuthorization: () => authorizeMessages(props.channelId),
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
`getState()`, `getSnapshot()`, `awaitTxId()`, `renew()`, and lower-level event
listeners. Register listeners in an effect. `utils` omits `unsubscribe()`
because React owns cleanup when the component unmounts or its authorization
changes.

When `refreshAuthorization` is present, the integration renews before expiry
and keeps retrying through capability expiry and transport outages. Existing
data remains available with status `stale`. Changing the authorization starts
a new logical query; changing only the refresh callback does not.

For SSR, execute the same query on the server and pass its rows as
`initialData`. React renders them immediately as stale data, and the first
authoritative Neon Live reset reconciles any intervening changes.

### Optimistic mutations

React's `useOptimistic()` can overlay application-defined changes while Neon
Live remains the authoritative source. Keep the optimistic Action pending until
the subscription has applied the mutation's PostgreSQL transaction:

```tsx
import { startTransition, useOptimistic } from "react";

const { data = [], utils } = useLiveQuery(authorization);
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

**Warning:** `awaitTxId()` resolves only when Neon Live includes the transaction
ID in a live batch for this query. Neon Live does not currently acknowledge
transactions that produce no changes to the query result. Pass a timeout or
avoid waiting when the mutation endpoint reports that no change was made.

## API

- `NeonLiveProvider` supplies one existing `NeonLiveClient` to descendant
  hooks. It does not fetch authorizations or own the client's lifetime.
- `useLiveQuery(authorization, options)` owns one materialized subscription and
  cleans it up when the component unmounts or the authorization changes.
- `UseLiveQueryOptions`, `UseLiveQueryResult`, and `UseLiveQueryUtils` are
  exported for reusable component and framework typings.
