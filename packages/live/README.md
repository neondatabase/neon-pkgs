# @neon/live

Experimental typed SDK for authorizing Neon Live queries on an application
backend and consuming them from browser applications. The backend turns a
parameterized query into a short-lived encrypted bearer capability. The
browser presents that capability over a multiplexed WebSocket and receives an
authoritative result followed by atomic change batches.

> **Status:** Neon Live is experimental. Its APIs and wire protocol may change
> before a stable release.

## Install

```bash
npm install @neon/live
```

> **Requirements:** Node.js >= 20.19 for backend authorization. You also need a
> PostgreSQL database connected to a compatible Neon Live proxy, a server-only
> Neon Live secret, and the proxy WebSocket URL.

The package has no runtime dependencies. Import browser and backend code from
their dedicated entry points so server secrets cannot enter a browser bundle:

```ts
import { createNeonLiveClient } from "@neon/live/client";
import { createNeonLive } from "@neon/live/server";
```

| Entry point | Purpose |
| --- | --- |
| `@neon/live/server` | Authorize raw SQL or adapter-native queries on an application backend. |
| `@neon/live/client` | Subscribe from a browser and consume materialized or raw changes. |
| `@neon/live` | Convenience export of both surfaces; prefer the dedicated entry points in application code. |

## Authorize a query on the backend

An authenticated application endpoint constructs the exact query its caller
may observe and returns the resulting authorization:

```ts
import { createNeonLive, rawSql } from "@neon/live/server";

interface Message {
  id: number;
  body: string;
}

const neonLive = createNeonLive({
  secret: process.env.NEON_LIVE_SECRET!,
  db: "app",
});

app.post("/api/messages/live", async (request, response) => {
  const user = await requireUser(request);
  const channelId = await channelVisibleTo(user, request.body.channelId);
  const query = rawSql<Message>(
    "select id, body from messages where channel_id = $1",
    [channelId],
  );

  response.json(await neonLive.authorize({ query }));
});
```

`authorize()` performs local Web Crypto work and makes no network request. The
application remains responsible for authentication, input validation, access
checks, and putting every trusted caller-specific restriction into the query.
Anyone holding the returned capability can subscribe to that exact query until
it expires.

`db` is embedded in each encrypted capability. The first capability accepted
on a browser client binds its WebSocket to that database; later subscriptions
on that client must target the same database.

### Raw SQL parameters

Bare strings, numbers, booleans, bigints, and `null` are sent in PostgreSQL text
format with type OID `0`, allowing PostgreSQL to infer their types from SQL
context. Use `pgParam` when a JavaScript value does not identify one PostgreSQL
encoding:

```ts
import { pgParam, rawSql } from "@neon/live/server";

const query = rawSql<Message>(
  `select id, body
     from messages
    where sent_at >= $1
      and metadata @> $2
      and labels && $3`,
  [
    pgParam.timestamptz(since),
    pgParam.jsonb({ visible: true }),
    pgParam.array("text", ["important", "unread"]),
  ],
);
```

The wrappers cover `date`, `timestamp`, `timestamptz`, `json`, `jsonb`,
`bytea`, and PostgreSQL arrays. `pgParam.text(type, encodedValue)` accepts any
other value already in PostgreSQL text format. Known built-in types use their
stable OID; database-specific types use OID `0` and must be resolvable from the
query context or an explicit SQL cast.

For typed Drizzle queries, install `@neon/live-drizzle` and configure its
adapter when creating the backend SDK.

## Subscribe directly from a trusted environment

A trusted, long-lived process can let the SDK hide capability issuance and
renewal. Add the same WebSocket URL accepted by `createNeonLiveClient()`, then
pass a concrete query directly to `subscribe()`:

```ts
const neonLive = createNeonLive({
  secret: process.env.NEON_LIVE_SECRET!,
  db: "app",
  url: "wss://live.neon.tech/...",
});

const subscription = await neonLive.subscribe(
  rawSql<Message>("select id, body from messages"),
);

const stop = subscription.onChange(({ data, status, error }) => {
  // The same subscription API returned by createNeonLiveClient().
});

stop();
subscription.unsubscribe(); // Stop this query.
neonLive.close(); // Stop every query and close the shared WebSocket.
```

Use `{ materialize: false }` as the second argument to consume raw resets and
batches. Direct subscriptions share one lazily opened client, prepare the query
once, and mint replacement capabilities automatically. `subscribe()` resolves
after the initial capability is minted; use the subscription lifecycle to know
when its first authoritative result is live.

During an outage, the logical subscription remains `stale` with its latest
materialized rows. The SDK keeps minting current capabilities and reconnecting
with backoff. If the subscription expires, recovery creates a new
wire subscription behind the same public object and returns to `live` after its
fresh authoritative reset.

This mode holds the Neon Live secret and can authorize arbitrary queries. Use
it only in trusted runtimes, never in browser code. The runtime must provide a
standards-compatible global `WebSocket` implementation.

## Subscribe in the browser

Fetch the authorization from the application backend and pass it to one shared
client:

```ts
import { createNeonLiveClient } from "@neon/live/client";

const response = await fetch("/api/messages/live", { method: "POST" });
if (!response.ok) throw new Error("Could not authorize messages");

const authorization = await response.json();
const client = createNeonLiveClient({
  url: "wss://live.neon.tech/...",
});
const subscription = client.subscribe(authorization);

const stop = subscription.onChange(({ data, status, error }) => {
  if (error) showError(error);
  else if (data) renderMessages(data, status);
});

// Later:
stop();
subscription.unsubscribe();
client.close();
```

The client opens one WebSocket lazily and multiplexes subscriptions. Lifecycle
states are `connecting`, `live`, `stale`, `error`, and `closed`. During
reconnection or authorization renewal, existing materialized data remains
available as `stale`. Recoverable connection failures retry with capped
jittered backoff until the connection recovers or the client is closed.

The current decoder supports PostgreSQL `integer` (`int4`) and `text` result
columns, including SQL `NULL`. Cast other selected values to a supported result
type until the corresponding browser codec is available. Parameter support is
separate: the backend can encode the additional types documented above even
when they are not yet supported as selected result columns.

Applications obtain a replacement capability through the same backend endpoint
and call `subscription.renew(replacement)`. The SDK rejects a replacement for a
different query by comparing its public query fingerprint. If the previous
capability has already expired, the subscription remains `stale` and `renew()`
opens a new subscription behind the same public object. Its next full
reset replaces the retained rows and returns it to `live`.

### Raw subscriptions

The default subscription materializes query rows. Integrations that own their
state can consume raw resets and atomic batches instead:

```ts
const raw = client.subscribe(authorization, { materialize: false });

raw.onReset((rows) => replaceAll(rows));
raw.onBatch((changes, { txids }) => {
  applyCommittedChanges(changes);
  for (const txid of txids) confirmMutation(txid);
});
```

Every raw row and change has an opaque `rowId`. Do not interpret it as a primary
key or retain it across resets. Transaction IDs are decimal strings so 64-bit
values remain exact in JavaScript.

For SSR, pass server-executed rows as `initialData` when subscribing. They are
available immediately as stale data until the first authoritative reset.

## Integrations and examples

- [`@neon/live-react`](../live-react) provides `NeonLiveProvider` and
  `useLiveQuery()`.
- [`@neon/live-tanstack`](../live-tanstack) synchronizes a query into a TanStack
  DB collection.
- [`@neon/live-drizzle`](../live-drizzle) authorizes typed Drizzle PostgreSQL
  selects.

Treat authorizations as bearer credentials: deliver them over HTTPS and keep
them out of URLs, logs, and persistent browser storage. Never expose
`NEON_LIVE_SECRET` to browser code.
