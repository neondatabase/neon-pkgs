# @neon/realtime

Experimental typed Realtime SDK for sealing live queries on an application
backend and consuming them from browser applications. The backend turns a
parameterized query into a short-lived encrypted bearer capability. The
browser presents that capability over a multiplexed WebSocket and receives an
authoritative result followed by atomic change batches.

> **Status:** Realtime is experimental. Its APIs and wire protocol may change
> before a stable release.

## Install

```bash
npm install @neon/realtime
```

> **Requirements:** Node.js >= 20.19 for backend sealing. You also need a
> PostgreSQL database connected to a compatible Realtime endpoint, a server-only
> Realtime secret, and the endpoint WebSocket URL.

The package has no runtime dependencies. Import browser and backend code from
their dedicated entry points so server secrets cannot enter a browser bundle:

```ts
import { createRealtimeClient } from "@neon/realtime/client";
import { createRealtime } from "@neon/realtime/server";
```

| Entry point | Purpose |
| --- | --- |
| `@neon/realtime/server` | Seal raw SQL or adapter-native queries on an application backend. |
| `@neon/realtime/client` | Subscribe from a browser and consume materialized or raw changes. |
| `@neon/realtime` | Convenience export of both surfaces; prefer the dedicated entry points in application code. |

## Seal a query on the backend

An authenticated application endpoint constructs the exact query its caller
may observe and returns the resulting sealed query:

```ts
import { createRealtime, rawSql } from "@neon/realtime/server";

interface Message {
  id: number;
  body: string;
}

const realtime = createRealtime({
  secret: process.env.NEON_REALTIME_SECRET!,
  db: "app",
});

app.post("/api/messages/live", async (request, response) => {
  const user = await requireUser(request);
  const channelId = await channelVisibleTo(user, request.body.channelId);
  const query = rawSql<Message>(
    "select id, body from messages where channel_id = $1",
    [channelId],
  );

  const sealedQuery = await realtime.seal({ query });
  response.json(sealedQuery);
});
```

`seal()` performs local Web Crypto work and makes no network request. The
application remains responsible for authentication, input validation, access
checks, and putting every trusted caller-specific restriction into the query.
Anyone holding the returned capability can subscribe to that exact query until
it expires.

By default, subscription errors use safe client-facing messages. During local
development, pass `debugMode: true` to `createRealtime()` to include full
database diagnostics in errors returned by the Realtime endpoint. Detailed
errors can expose schema, table, and column names, so never enable this for
untrusted clients in production. When PostgreSQL supplies a SQLSTATE, it is
available as `error.sqlState` on the subscription error.

`db` is embedded in each encrypted capability. The first capability accepted
on a browser client binds its WebSocket to that database; later subscriptions
on that client must target the same database.

### Raw SQL parameters

Bare strings, numbers, booleans, bigints, and `null` are sent in PostgreSQL text
format with type OID `0`, allowing PostgreSQL to infer their types from SQL
context. Use `pgParam` when a JavaScript value does not identify one PostgreSQL
encoding:

```ts
import { pgParam, rawSql } from "@neon/realtime/server";

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

For typed Drizzle queries, install `@neon/realtime-drizzle` and configure its
adapter when creating the backend SDK.

For typed Kysely queries, install `@neon/realtime-kysely` and configure its
adapter in the same way.

## Subscribe directly from a trusted environment

A trusted, long-lived process can let the SDK hide capability issuance and
renewal. Add the same WebSocket URL accepted by `createRealtimeClient()`, then
pass a concrete query directly to `subscribe()`:

```ts
const realtime = createRealtime({
  secret: process.env.NEON_REALTIME_SECRET!,
  db: "app",
  url: "wss://live.neon.tech/...",
  logLevel: "warn",
});

const subscription = await realtime.subscribe(
  rawSql<Message>("select id, body from messages"),
);

const stop = subscription.onChange(({ data, status, error }) => {
  // The same subscription API returned by createRealtimeClient().
});

stop();
subscription.unsubscribe(); // Stop this query.
realtime.close(); // Stop every query and close the shared WebSocket.
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

This mode holds the Realtime secret and can seal arbitrary queries. Use
it only in trusted runtimes, never in browser code. The runtime must provide a
standards-compatible global `WebSocket` implementation.
`createRealtime({ url, parsers })` accepts the same OID overrides as the
low-level client for trusted direct-subscription results.
It also accepts the client-side `logLevel` and `logger` options described
below. These diagnostics are independent from any server-side option that
controls how much error detail the proxy may disclose.

## Subscribe in the browser

Fetch the sealed query from the application backend and pass it to one shared
client:

```ts
import { createRealtimeClient } from "@neon/realtime/client";

const response = await fetch("/api/messages/live", { method: "POST" });
if (!response.ok) throw new Error("Could not start live messages");

const sealedQuery = await response.json();
const client = createRealtimeClient({
  url: "wss://live.neon.tech/...",
});
const subscription = client.subscribe(sealedQuery);

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
reconnection or sealed-query renewal, existing materialized data remains
available as `stale`. Recoverable connection failures retry with capped
jittered backoff until the connection recovers or the client is closed.

Some subscription errors also retry automatically:

- `backend_overloaded` (`subscribe_rejected` or `subscription_error`): the
  service is shedding load. The response carries `retry_after_ms`, the time
  until the service admits that database again.
- `subscribe_rejected` with `resource_exhausted`: the service instance is full.
  It usually carries `retry_after_ms` as well.
- `subscribe_rejected` with `backend_unavailable`, and `subscription_error` with
  `upstream_cancelled`.

After `backend_overloaded` or `resource_exhausted`, the service may also close a
connection that has no other subscriptions, so the client can reconnect to
another instance. The client reconnects on its own backoff and resubscribes once
the hint has passed.

Only the affected subscription is retried, using the current socket and latest
sealed query; other subscriptions keep receiving updates. Its last complete
result remains `stale` (or `connecting` if no result has arrived). Re-admission
uses a fresh request and live ID and installs a new baseline.

A retry with a hint never runs before it. With the hint `h` (at least 100 ms),
the SDK waits a random time in `[h, max(h, min(2h, cap))]`, which spreads
clients across the service's ramp-up. `cap` defaults to 30 seconds and is set
with `reconnect.overloadJitterCapMs`. Without a hint, retries use equal-jitter
delays that start at 0.5–1 second, grow exponentially, and cap at 30–60 seconds.

All retries of a subscription share one recovery episode: hint-paced retries
count toward the attempt and elapsed-time bounds but do not grow the
exponential delay. Admission rejections, brief re-admissions, and socket
reconnects do not reset the episode. It resets after a complete baseline
remains live for 30 seconds. Unsubscribing or closing the client cancels
pending retries.

### Client diagnostics

Client diagnostics are silent by default. Set `logLevel` to write structured
entries to the matching `console` method in browsers or Node.js:

```ts
const client = createRealtimeClient({
  url: "wss://live.neon.tech/...",
  logLevel: "warn",
});
```

The levels are cumulative:

| Level | Includes |
| --- | --- |
| `silent` | Nothing; this is the default |
| `error` | Terminal connection, subscription, decoding, and refresh failures |
| `warn` | Errors plus recoverable outages, expiry, refresh-callback failures, and renewal failures |
| `info` | Warnings plus connection, subscription, and renewal milestones |
| `debug` | All entries, including retry scheduling, heartbeats, baseline syncs, publications, and state transitions |

Each entry has a stable `event` name:

| Minimum level | Events |
| --- | --- |
| `error` | `connection_failed`, `connection_reconnect_exhausted`, `subscription_failed`, `subscription_row_decoding_failed`, `query_refresh_stopped` |
| `warn` | `connection_lost`, `query_expired`, `query_refresh_callback_failed`, `subscription_renewal_failed`, `subscription_listener_failed` |
| `info` | `connection_ready`, `connection_recovered`, `subscription_live`, `subscription_renewed`, `client_closed` |
| `debug` | `connection_attempt_started`, `connection_reconnect_scheduled`, `connection_stable`, `connection_heartbeat_ping_sent`, `connection_heartbeat_pong_received`, `connection_heartbeat_timeout`, `connection_publication_committed`, `subscription_started`, `subscription_admitted`, `subscription_renewal_started`, `subscription_unsubscribed`, `subscription_state_changed`, `subscription_baseline_sync_started`, `subscription_baseline_sync_completed`, `subscription_reset_required`, `subscription_retry_scheduled`, `query_refresh_scheduled`, `query_refresh_callback_started`, `query_refresh_callback_succeeded` |

`subscription_retry_scheduled` includes the server `code`, the one-based
`attempt` within the recovery episode, and the next `delayMs`, so repeated
admission rejections remain visible while a subscription stays stale.

Supply `logger` to route the same structured entries into an application
logger. `logLevel` still controls which entries it receives:

```ts
import type { RealtimeLogEntry } from "@neon/realtime/client";

const client = createRealtimeClient({
  url: "wss://live.neon.tech/...",
  logLevel: "info",
  logger: (entry: RealtimeLogEntry) => {
    appLogger[entry.level]({ ...entry });
  },
});
```

Entries are delivered from a microtask after the state transition that emitted
them, and logger failures are ignored, so observability cannot re-enter or
interrupt stream delivery. SDK-produced metadata uses client-local opaque
subscription IDs and does not include sealed capabilities, SQL, parameters,
rows, cell values, raw wire messages, or endpoint URLs. An entry's `error` may
retain an error reported by the proxy or thrown by application or runtime code,
so route it according to the application's normal error-logging policy. React
and TanStack DB refresh callbacks automatically reuse the diagnostics
configured on their shared client.

### PostgreSQL result values

The client includes browser-safe parsers that follow the familiar
node-postgres and Neon Serverless defaults:

| PostgreSQL type | JavaScript value |
| --- | --- |
| `bool` | `boolean` |
| `int2`, `int4`, `oid`, `float4`, `float8` | `number` |
| `int8`, `numeric` | `string` |
| `json`, `jsonb` | Parsed JSON value |
| `date`, `timestamp`, `timestamptz` | `Date` |
| `time`, `timetz` | `string` |
| `bytea` | `Uint8Array` |
| Text, UUID, network, unsupported, and unknown types | PostgreSQL text |

Built-in PostgreSQL arrays using the standard comma delimiter are parsed
recursively with the corresponding element parser. Arrays with another type
delimiter, such as `box[]`, remain PostgreSQL text. SQL `NULL` bypasses parsers
and remains JavaScript `null`.
`date` and zone-less `timestamp` use the runtime's local timezone, as
node-postgres does; `timestamptz` represents its absolute instant. PostgreSQL
microseconds are truncated to JavaScript milliseconds.

Override a parser by OID when the application uses a different representation:

```ts
import {
  createRealtimeClient,
  pgTypeOids,
} from "@neon/realtime/client";

const customTypeOid = 90_000;
const client = createRealtimeClient({
  url: "wss://live.neon.tech/...",
  parsers: {
    [pgTypeOids.int8]: (value) => BigInt(value),
    [customTypeOid]: (value: string) => parseCustomType(value),
  },
});
```

Known OIDs are contextually typed: OID `17` (`pgTypeOids.bytea`) receives
`Uint8Array`, while other built-in OIDs receive PostgreSQL text. Annotate an
arbitrary custom OID parser's input as `string`. The client snapshots the
configuration, so later object mutation has no effect. A scalar override also
applies inside its known array type.

`nodePostgresParsers` exposes the core preset and is already active by default.
Spread `postgresJsParsers` into `parsers` to match PostgreSQL.js where it
differs within the supported set. `@neon/realtime-drizzle/client` similarly exports
`drizzleParsers` without importing the Drizzle runtime.

Missing parsers deliberately return exact PostgreSQL text without warning.
Malformed built-in values or an application parser that throws move only the
affected subscription to non-retryable `parser_error`; other subscriptions on
the WebSocket continue. The error identifies the result column and OID, omits
the value, and preserves the parser's original error as `cause`.

Parser configuration is runtime-only; it does not rewrite the `Row` type in a
`SealedLiveQuery<Row>`. Keep adapter-inferred or explicitly declared
row types consistent with the selected parser preset and overrides.

Applications obtain a replacement capability through the same backend endpoint
and call `subscription.renew(replacement)`. The SDK rejects a replacement for a
different query by comparing its public query fingerprint. If the previous
capability has already expired, the subscription remains `stale` and `renew()`
opens a new subscription behind the same public object. Its next full
reset replaces the retained rows and returns it to `live`.

After a mutation returns its PostgreSQL transaction ID, use `awaitTxId()` to
wait until that transaction has been applied to this subscription:

```ts
const { txid } = await updateMessage(messageId, { body: "Updated" });
await subscription.awaitTxId(txid);
```

The subscription remembers recently applied transaction IDs, so this is safe
when the live batch arrives before the mutation response. An optional timeout
in milliseconds can bound the wait. Without one, the promise remains pending
until the transaction arrives or the subscription closes.

`awaitTxId()` does not determine whether a transaction committed, so pass only
the ID of a transaction known to have committed.

Materialized subscriptions can instead wait for their complete rows to satisfy
an application predicate:

```ts
await subscription.awaitRows(
  (rows) =>
    rows.some(
      (message) =>
        message.id === messageId && message.body === "Updated",
    ),
  10_000,
);
```

`awaitRows()` checks the current snapshot before listening for later changes,
waits indefinitely when its optional timeout is omitted, and rejects if the
subscription closes or enters a terminal error. Use a unique version,
timestamp, or mutation identifier in the predicate when it must confirm a
specific mutation; pre-existing or unrelated rows can otherwise satisfy it.
Raw subscriptions do not expose `awaitRows()` because they do not retain the
complete result.

### Raw subscriptions

The default subscription materializes query rows. Integrations that own their
state can consume raw resets and atomic batches instead:

```ts
const raw = client.subscribe(sealedQuery, { materialize: false });

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
Realtime does not transform those rows: the application is responsible for making
their JavaScript representation match the configured live parsers. The core
defaults align with node-postgres and Neon Serverless for built-in types, while
the optional presets cover common driver and ORM differences. Framework date
serialization and server/browser timezone alignment remain application
concerns.

## Integrations and examples

- [`@neon/realtime-react`](../realtime-react) provides `RealtimeProvider` and
  `useLiveQuery()`.
- [`@neon/realtime-tanstack`](../realtime-tanstack) synchronizes a query into a TanStack
  DB collection.
- [`@neon/realtime-drizzle`](../realtime-drizzle) prepares typed Drizzle PostgreSQL
  selects.
- [`@neon/realtime-kysely`](../realtime-kysely) prepares typed Kysely PostgreSQL
  selects.

Treat sealed queries as bearer credentials: deliver them over HTTPS and keep
them out of URLs, logs, and persistent browser storage. Never expose
`NEON_REALTIME_SECRET` to browser code.

## Protocol schemas

The package exports its versioned protocol and decoded capability schemas at
`@neon/realtime/schema/realtime-protocol-v1.schema.json` and
`@neon/realtime/schema/realtime-query-capability-v1.schema.json`.
See the [schema maintenance notes](schema/README.md) for generation and
downstream synchronization.
