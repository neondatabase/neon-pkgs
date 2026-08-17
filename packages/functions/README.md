# @neon/functions

Runtime helpers for [Neon Functions](https://neon.com):

- **`waitUntil`** — defer background work past a response.
- **`upgradeWebSocket`** — serve WebSockets from a `fetch` handler.
- **`attachDatabasePool`** — keep a module-scope `pg.Pool` from killing the isolate when Postgres drops an idle client.

## Install

```bash
npm install @neon/functions
```

> **Requirements:** Node.js >= 20.19.

## `waitUntil`

The API mirrors [`@vercel/functions`](https://vercel.com/docs/functions/functions-api-reference/vercel-functions-package): import `waitUntil` and call it directly with the promise you want to keep alive.

```ts
import { waitUntil } from "@neon/functions";

export default {
	async fetch(req: Request): Promise<Response> {
		// Fire-and-forget background work that should outlive the response.
		waitUntil(logRequest(req));
		return new Response("ok");
	},
};
```

`waitUntil(promise)` forwards the promise to the Neon Functions runtime, which keeps
the invocation alive until the promise settles (up to the 15-minute `waitUntil` limit).
When no invocation context is in scope — local dev, tests, or any non-Neon host — it is
a **no-op**: the promise is accepted and ignored (it still runs on its own, it just
isn't tracked), so the same code runs everywhere without branching. Passing a
non-`Promise` throws a `TypeError`.

## `upgradeWebSocket`

Turn an incoming WebSocket handshake into a live connection from inside your normal
`fetch` handler. The API mirrors
[`Deno.upgradeWebSocket`](https://docs.deno.com/api/deno/~/Deno.upgradeWebSocket):

```ts
import { upgradeWebSocket } from "@neon/functions";

export default {
	async fetch(req: Request): Promise<Response> {
		if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
			return new Response("expected a websocket upgrade", { status: 426 });
		}

		const { socket, response } = upgradeWebSocket(req);
		socket.addEventListener("message", (event) => socket.send(event.data));
		return response;
	},
};
```

`socket` is a standard [`WebSocket`](https://developer.mozilla.org/en-US/docs/Web/API/WebSocket),
so both `addEventListener` and the `onmessage`/`onopen`/`onclose`/`onerror` properties work.
It is still `CONNECTING` when you get it: the runtime writes the `101` only once your
handler returns `response`, and the socket opens (firing `open`) at that point.

**Return `response` unchanged.** A `101` cannot be expressed as a plain `Response` — the
fetch spec restricts constructed responses to statuses 200–599 — so the runtime hands back
a response object that carries the pending upgrade. Cloning it, or rebuilding it
(`new Response(res.body, res)`, which response-rewriting middleware does), discards the
upgrade; the runtime detects that and fails the request loudly rather than leaving your
client waiting on a connection nobody upgraded.

### Subprotocols

Pass `protocol` to select one of the subprotocols the client offered, which is echoed back
in `Sec-WebSocket-Protocol`:

```ts
const { socket, response } = upgradeWebSocket(req, { protocol: "chat.v2" });
```

Per [RFC 6455 §4.2.2](https://datatracker.ietf.org/doc/html/rfc6455#section-4.2.2) a server
may only select a protocol the client offered, so passing one the client did not offer
throws a `TypeError` instead of producing a handshake the client will reject. Omit it and
no protocol is negotiated: the response header is absent and `socket.protocol` is `""`.

### Notes

- `binaryType` defaults to `"arraybuffer"` rather than the browser default of `"blob"`,
  matching Deno and other server runtimes. Setting it to `"blob"` is supported.
- `extensions` is always `""`. No extensions — including `permessage-deflate` — are
  negotiated.
- Unlike `waitUntil`, this **throws a `TypeError` off-platform** (and on a request that is
  not a WebSocket handshake). There is no meaningful degraded WebSocket, so an error that
  says so beats a socket that could never open.

### Requires a runtime with WebSocket support

`upgradeWebSocket` needs a Neon Functions runtime that provides the upgrade — deployed, or
locally under `neon dev`. On an older runtime it throws the "only available inside a Neon
Functions invocation" `TypeError` rather than misbehaving.

## `attachDatabasePool`

A Neon Function reuses a `pg.Pool` across requests on the same isolate. When Postgres
closes an idle client — compute scale-to-zero, pooler reclaim, a TCP reset — node-postgres
emits `error` on the pool. With no listener, that is an uncaught exception and the isolate
exits.

Call this once after constructing the pool. The pool has already discarded the dead client;
the next checkout opens a new connection.

```ts
import { attachDatabasePool } from "@neon/functions";
import { Pool } from "pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
attachDatabasePool(pool);
```

This helper does not need a Neon Functions runtime. The same call works in plain Node
and under `neon dev`.

Expected idle disconnects (`ECONNRESET`, `EPIPE`, `ETIMEDOUT`, Postgres `57P01`, and
node-postgres's `Connection terminated unexpectedly`) are silent. Anything else is
logged with `console.error`.

To send unexpected errors to your own reporter instead of `console.error`, pass it on
the first call, next to `new Pool`:

```ts
import * as Sentry from "@sentry/node";
import { attachDatabasePool } from "@neon/functions";
import { Pool } from "pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
attachDatabasePool(pool, {
	onUnexpectedError: (err) => Sentry.captureException(err),
});
```

The first call wins. A second `attachDatabasePool(pool)` is a no-op. A second call that
passes `onUnexpectedError` is also a no-op and logs a warning.

If `onUnexpectedError` throws, or returns a promise that rejects, both the pool error and
the reporter error are logged. Neither is rethrown from the listener, so the isolate stays up.

This does not close the pool. Isolate teardown tears the connections down with the process.

## Runtime integration

The runtime publishes the active invocation context on `globalThis.NEON_REQUEST_CONTEXT`
as a getter that returns the live context object directly — `{ waitUntil }` during an
invocation, `undefined` outside one. `waitUntil` reads that value straight off the
global, so there is nothing for application code to wire up.

`upgradeWebSocket` works the same way, reading a bridge the runtime publishes under
`Symbol.for("neon.websocket.bridge")`. All of the protocol work — the handshake, framing,
fragmentation, ping/pong and the close handshake — lives in the runtime; this package is
only a typed facade over it.
