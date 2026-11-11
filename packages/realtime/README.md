# @neon/realtime

Experimental typed Realtime SDK for sealing live queries on an application
backend and consuming them from browser applications. The backend turns a
parameterized query into a short-lived encrypted bearer capability. The
browser presents that capability over a multiplexed WebSocket and receives an
authoritative result followed by atomic change batches.

The capability is an envelope sealed to the branch's public key. It carries
the query and the backend's Postgres login, which Realtime checks with a real
Postgres login. The browser can neither read nor change it.

> **Status:** Realtime is experimental. Its APIs and wire protocol may change
> before a stable release.

## Install

```bash
npm install @neon/realtime
```

> **Requirements:** Node.js >= 20.19 for backend sealing. You also need a
> PostgreSQL database connected to a compatible Realtime endpoint, its
> connection string (`DATABASE_URL`) for the `neondb_owner` role, and the
> endpoint WebSocket URL (`NEON_REALTIME_URL`).

Import browser and backend code from their dedicated entry points so server
credentials cannot enter a browser bundle:

```ts
import { createRealtimeClient } from "@neon/realtime/client";
import { createRealtime } from "@neon/realtime/server";
```

| Entry point | Purpose |
| --- | --- |
| `@neon/realtime/server` | Seal raw SQL or adapter-native queries on an application backend. |
| `@neon/realtime/client` | Subscribe from a browser and consume materialized or raw changes. |
| `@neon/realtime` | Convenience export of both surfaces; React Native resolves this entry point to the client surface only. Prefer the dedicated entry points in application code. |

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
  databaseUrl: process.env.DATABASE_URL!,
  url: process.env.NEON_REALTIME_URL!,
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

`seal()` performs local Web Crypto work. Its only network request fetches the
branch's public key, which it caches (see [Credentials](#credentials)). The
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

The database is embedded in each encrypted capability. It defaults to the one
in `databaseUrl`; pass `db` to choose another. The first capability accepted
on a browser client binds its WebSocket to that database; later subscriptions
on that client must target the same database.

### Credentials

`databaseUrl` is a Postgres connection string, such as `DATABASE_URL`. Each
capability is a v3 envelope, sealed with HPKE (P-256) to the branch's public
key, that carries the URL's user and password. Realtime opens it and checks
that login against Postgres, so password changes, `NOLOGIN` and role settings
apply to Realtime too. No Realtime secret is involved.

- **Role.** Realtime supports only `neondb_owner` for now. Another user is a
  configuration error when `createRealtime()` runs.
- **Vercel OIDC.** When the URL has no password, as in Vercel projects that use
  OIDC, the credential is an OIDC token. By default the SDK reads Vercel's
  runtime token: the request's `x-vercel-oidc-token` header, then
  `VERCEL_OIDC_TOKEN`. Pass `oidcToken` to supply tokens yourself. An empty
  password never means "send no credential". The SDK reuses a token until 60
  seconds before its `exp`, so Realtime's login cache keeps working.

  ```ts
  const realtime = createRealtime({
    databaseUrl: "postgresql://neondb_owner@ep-example.neon.tech/neondb",
    url: process.env.NEON_REALTIME_URL!,
    oidcToken: () => getTokenFromMyProvider(),
  });
  ```

- **Public key.** The SDK fetches the key from
  `/.well-known/neon-realtime-keys` on the `url` host (`wss://` becomes
  `https://`) and caches it per process as the response's `Cache-Control`
  allows, at most 10 minutes. The request opts out of framework fetch caches.
  It may start the branch's Realtime VM, so each attempt has 30 seconds, and
  a timeout or a `502`, `503` or `504` is retried once after a second.
  Concurrent seals share one request. Pass `fetch` to use your own, for
  example for a custom CA, or on a runtime that rejects `cache: "no-store"`.
- **Legacy secret.** Without `databaseUrl`, `createRealtime({ secret, db })`
  keeps sealing the previous token format with the shared Realtime secret, and
  makes no network request.

### Migrating from the Realtime secret

Configure both while your branches move to Postgres credentials, and the SDK
picks the scheme for each branch:

```ts
const realtime = createRealtime({
  databaseUrl: process.env.DATABASE_URL!,
  secret: process.env.NEON_REALTIME_SECRET,
  url: process.env.NEON_REALTIME_URL!,
});
```

| The branch's keys endpoint answers | The SDK seals |
| --- | --- |
| A current key | An envelope with the Postgres login |
| `400` or `404` (a Realtime server from before envelopes answers `400`), or an empty key list | A legacy token with `secret`; without a secret, it throws "This branch has no Realtime key yet" |
| A network error, a timeout, `5xx` or an unreadable answer | Nothing: `seal()` throws, and the secret is not used |

The SDK rechecks a branch without a key at most a minute later, so it starts
sealing envelopes soon after the branch's key is published. It never retries a
failed or rejected envelope with the secret, so a branch whose secret is
turned off is not exposed to it. Once every branch publishes a key, drop
`secret`. Servers keep accepting tokens from older SDKs, and the browser
client accepts both kinds.

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

Custom `RealtimeAdapter` implementations may set `querySource: "custom"`.
Official adapters identify their fixed query-builder family automatically.
Realtime records only this bounded category; it does not accept arbitrary
adapter names or versions.

## Subscribe directly from a trusted environment

A trusted, long-lived process can let the SDK hide capability issuance and
renewal. With `url`, the same WebSocket URL accepted by
`createRealtimeClient()`, pass a concrete query directly to `subscribe()`:

```ts
const realtime = createRealtime({
  databaseUrl: process.env.DATABASE_URL!,
  url: process.env.NEON_REALTIME_URL!,
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

Use `{ materialize: false }` as the second argument to consume complete rows and
incremental changes. Direct subscriptions share one lazily opened client,
prepare the query once, and mint replacement capabilities automatically.
`subscribe()` resolves after the initial capability is minted; use the
subscription lifecycle to know when its first authoritative result is live.

During an outage, the logical subscription becomes `connecting` while retaining
its latest materialized rows. The SDK keeps minting current capabilities and
reconnecting with backoff. If the capability expires, the subscription is
`stale` while awaiting its replacement, then becomes `connecting` while recovery
creates a new wire subscription behind the same public object. It returns to
`live` after receiving a fresh authoritative result.

This mode holds the database credentials and can seal arbitrary queries. Use
it only in trusted runtimes, never in browser code. Direct subscriptions use
the optional `ws` peer dependency so stalled close handshakes can be terminated.
Install `ws` in applications that call `createRealtime()`; browser and
low-level client applications do not need it.

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
initial connection, reconnection, or resubscription, existing materialized data
remains available with status `connecting`. `stale` specifically means that the
capability has expired and the low-level client is waiting for the application
to call `renew()`. Recoverable connection failures retry with capped jittered
backoff until the connection recovers or the client is closed.

### React Native WebSocket origins

React Native's WebSocket implementation sends an `Origin` header derived from
the Realtime endpoint. If the branch restricts Realtime to browser origins,
provide a custom WebSocket factory that sends one of those allowed origins:

```ts
const client = createRealtimeClient({
  url: websocketUrl,
  webSocketFactory: (url, protocols) =>
    new WebSocket(url, protocols, {
      headers: { origin: "https://app.example.com" },
    }),
});
```

The third constructor argument is a React Native extension and is unavailable
in browsers. An origin allowlist is a browser security boundary; native clients
can choose their own header value, so do not treat it as native-app
authentication.

Some subscription errors also retry automatically:

- `backend_overloaded` (`subscribe_rejected` or `subscription_error`): the
  service instance is shedding load or is full. The response carries
  `retry_after_ms`, the time until it admits that database again.
- `subscribe_rejected` with `backend_unavailable` or `resource_exhausted` (a
  service limit on this connection or process), and `subscription_error` with
  `upstream_cancelled`.

After `backend_overloaded`, the service may also close a connection that has no
other subscriptions, so the client can reconnect to another instance. The
client reconnects on its own backoff and resubscribes once the hint has passed.

Only the affected subscription is retried, using the current socket and latest
sealed query; other subscriptions keep receiving updates. Its last complete
result remains available with status `connecting`. Re-admission uses a fresh
request and live ID and installs a new baseline.

A retry with a hint never runs before it. With the hint `h` (at least 100 ms),
the SDK waits a random time in `[h, max(h, min(2h, cap))]`, which spreads
clients across the service's ramp-up. `cap` is 30 seconds. Hints support the full
unsigned 32-bit millisecond range. Without a hint, retries use equal-jitter
delays that start at 0.5–1 second, grow exponentially, and cap at 30–60 seconds.

All retries of a subscription share one recovery episode: hint-paced retries
count toward the attempt and elapsed-time bounds but do not grow the
exponential delay. Admission rejections, brief re-admissions, and socket
reconnects do not reset the episode. It resets after a complete baseline
remains live for 30 seconds. Unsubscribing or closing the client cancels
pending retries.

### Row type inference

`client.subscribe()` infers the live row type from the sealed query. Preloaded
`initialData` must match that type; it cannot remove selected columns or widen
their types to make an incompatible value fit.

### Client diagnostics

Client diagnostics are silent by default. Set `logLevel` to write structured
entries to the matching `console` method in browsers or Node.js:

```ts
const client = createRealtimeClient({
  url: "wss://live.neon.tech/...",
  logLevel: "warn",
});
```

Server-issued client warnings are an intentional exception: each distinct
warning is written once to `console.error`, regardless of `logLevel` or
`logger`. This keeps urgent compatibility notices visible in browser developer
tools without interrupting the connection or active subscriptions.

The levels are cumulative:

| Level | Includes |
| --- | --- |
| `silent` | No structured diagnostics; this is the default |
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
admission rejections remain visible while a subscription stays `connecting`.

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
capability has already expired, the subscription remains `stale` until `renew()`
is called. Calling it moves the subscription to `connecting` and opens a new
subscription behind the same public object. Its next complete result replaces
the retained rows and returns it to `live`.

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
state can consume a single ordered stream of complete rows and incremental
changes instead:

```ts
const raw = client.subscribe(sealedQuery, { materialize: false });

raw.onUpdate((update) => {
  if (update.type === "rows") {
    replaceAll(update.rows);
  } else {
    applyCommittedChanges(update.changes);
    for (const txid of update.batch.txids) confirmMutation(txid);
  }
});
```

Every raw row and change has an opaque `rowId`. Do not interpret it as a primary
key or retain it after a `rows` update replaces the complete result. Transaction
IDs are decimal strings so 64-bit values remain exact in JavaScript.

For ordered queries, materialized subscriptions preserve the server sequence.
An upsert replaces an existing row without moving it. A `move` change contains
`rowId` and `afterRowId`: remove that row from its current position and insert it
immediately after its predecessor, or at the head when `afterRowId` is `null`.
Apply contents first, then moves in their received order. Both identities must
exist after applying contents. A moved predecessor is placed earlier in the
batch. Every ordered patch entrant must have its own move, including a new tail
row. Moves carry no row payload.

Raw consumers must handle all three `LiveQueryChange` variants explicitly:

```ts
for (const change of update.changes) {
  switch (change.type) {
    case "upsert": upsertRow(change.rowId, change.row); break;
    case "remove": removeRow(change.rowId); break;
    case "move": moveRow(change.rowId, change.afterRowId); break;
  }
}
```

Raw updates contain complete committed batches, with public transport fragments
reassembled. Stage and validate an entire batch before exposing its result.
The core checks framing and program structure for raw consumers; it does not
retain a second result to check move rows, predecessors, or entrant placement.
An adapter preserving sequence owns those stateful checks after it has a
baseline. Core materialized subscriptions validate Move programs against prior
membership before installing any target, including while replaying the baseline
backlog. A content-only batch does not reveal whether its query is ordered, so
the core retains unordered keyed semantics for those batches. Application
callback side effects are outside SDK rollback; callbacks across independent
adapters are not a transaction.

### Partial refreshes

Most changes reach a live query as exact row patches. When the server can't
patch part of a result exactly, it recomputes just that part instead of the
whole result: it marks the affected rows as pending, re-runs the query for
them, and sends their new contents. Applications don't see this machinery,
and no API changes.

While a refresh is pending, the query keeps showing its last complete result,
and its status stays `live`. Changes committed in the meantime wait with the
refresh and become visible together when it lands, in one update, followed by
any later changes as their own updates. `awaitTxId()` resolves for a
transaction only once the result that includes it is visible. A full
replacement of the result behaves the same way, as it always has.

Raw subscriptions receive a landed refresh as an ordinary `changes` update,
never as a `rows` replacement. Each update is atomic: apply it as a whole. Rows
can exchange contents within one update, as when a refresh renumbers rows, so a
consumer that keys rows by their contents (for example a collection keyed by an
ID column) must check its keys against the update's final state rather than
change by change. For an unordered result, a refresh removes every row it
replaces before upserting the new contents, so even a change-by-change consumer
never sees one key held by two rows. For an ordered result, a refresh removes
only the rows that leave, upserts the rest, and moves each refreshed row into
place.

For SSR, pass server-executed rows as `initialData` when subscribing. They are
available immediately with status `connecting` until the first authoritative
result. Realtime does not transform those rows: the application is responsible
for making their JavaScript representation match the configured live parsers.
The core defaults align with node-postgres and Neon Serverless for built-in
types, while the optional presets cover common driver and ORM differences.
Framework date serialization and server/browser timezone alignment remain
application concerns.

The sealed query's inferred row type describes the **live, decoded rows**, even
when a JSON-aware RPC framework such as Hono or tRPC transforms the types of
actual HTTP response data. If a typed API response contains a query producing
`{ id: number; created_at: Date }` and initial rows serialized as JSON, restore
the date strings before subscribing:

```ts
// payload.query retains its Date row type; payload.initialData contains strings.
const initialData = payload.initialData.map((row) => ({
  ...row,
  created_at: new Date(row.created_at),
}));
const subscription = client.subscribe(payload.query, { initialData });
// subscription.getSnapshot().data: readonly { id: number; created_at: Date }[] | undefined
```

In this example, passing the unconverted `payload.initialData` is a type error.
No conversion is necessary when the application's serializer already restores
`Date` values. Realtime does not provide an HTTP/SSR deserializer or infer row
types from untyped JSON; preserve the typed sealed query through your
application's API boundary.

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
`DATABASE_URL` or `NEON_REALTIME_SECRET` to browser code.

## Tooling and tests

Two low-level helpers on `@neon/realtime/server` serve tooling and end-to-end
tests. Applications use `createRealtime()` instead.

- `fetchRealtimeKey(url, { fetch? })` fetches the branch's current public key,
  `{ kid, x, y }`, without caching.
- `sealRealtimeEnvelope({ key, db, user, credential, query, debugMode? })`
  seals one envelope for any user and credential, without the `neondb_owner`
  check, for example to confirm that Realtime itself rejects another role:

```ts
import { fetchRealtimeKey, rawSql, sealRealtimeEnvelope } from "@neon/realtime/server";

const key = await fetchRealtimeKey(process.env.NEON_REALTIME_URL!);
const sealedQuery = await sealRealtimeEnvelope({
  key,
  db: "neondb",
  user: "app_user",
  credential: "a-password",
  query: rawSql("select 1"),
});
```

## Upgrading to 0.2

Upgrade `@neon/realtime` and the official adapters together to 0.2.0. The new
adapter peer range is `^0.2.0`; older adapters accept only 0.1.x. Custom raw
consumers must implement the move variant before upgrading.

Existing `subscribe()` and React `useLiveQuery()` calls keep the same signatures.
Core materialized subscriptions and React handle ordered moves automatically.
Custom raw consumers should follow the complete-batch staging and validation
requirements above. TanStack collections retain unordered keyed semantics;
their local queries must establish any desired order.

The SDK requests only `neon.realtime.v3`, including on reconnect, so it needs an
endpoint that serves protocol v3. Protocol v3 is protocol v2 plus partial
refreshes. A custom WebSocket server used in tests must accept
`neon.realtime.v3` and send a `scope` on every `baseline_sync_start`, which is
`{ "kind": "all" }` for a full baseline. Protocols v1 and v2 remain available
for previously released clients. There is no client-side protocol fallback,
subscription opt-in, or mode acknowledgment.

## Protocol schemas

The package exports the active protocol and decoded capability schemas at
`@neon/realtime/schema/realtime-protocol.schema.json` (currently protocol v3),
`@neon/realtime/schema/realtime-query-capability.schema.json` (capability v2,
the legacy secret's tokens) and
`@neon/realtime/schema/realtime-query-capability-v3.schema.json` (capability v3,
the HPKE envelope). Their filenames stay stable across revisions; `$id` and
`title` retain each contract's version.

Existing versioned exports continue to resolve to their original contracts.
Protocol v1, protocol v2 and capability v1 resolve to frozen legacy snapshots;
the protocol v2 snapshot keeps the bytes that export always had. The versioned
protocol v3 and capability v2 exports alias the active contracts.
See the [schema maintenance notes](schema/README.md) for generation, legacy
removal and downstream synchronization.
