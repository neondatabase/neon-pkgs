# @neon/functions

Runtime helpers for [Neon Functions](https://neon.com):

- **`waitUntil`** — defer background work past a response.
- **`upgradeWebSocket`** — serve WebSockets from a `fetch` handler, or from a
  [Hono](https://hono.dev) route via `@neon/functions/hono`.

## Install

```bash
npm install @neon/functions
```

For the Hono route helper, install Hono alongside it:

```bash
npm install @neon/functions hono
```

> **Requirements:** Node.js >= 20.19. The `@neon/functions/hono` subpath declares
> `hono` `^4.7.8` as an optional peer — installing `@neon/functions` on its own
> pulls in nothing and warns about nothing.

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

## `@neon/functions/hono`

The same primitive, shaped as Hono's own WebSocket helper, so a route can serve a socket
directly. It is `defineWebSocketHelper` over `upgradeWebSocket` and nothing else — no `ws`
dependency, and not the deprecated `@hono/node-ws`.

```ts
import { Hono } from "hono";
import { upgradeWebSocket } from "@neon/functions/hono";

const app = new Hono();

app.get(
	"/ws",
	upgradeWebSocket(() => ({
		onOpen(_event, ws) {
			ws.send("welcome");
		},
		onMessage(event, ws) {
			ws.send(`echo: ${event.data}`);
		},
		onClose() {
			console.log("client disconnected");
		},
	})),
);

export default app;
```

A request without `Upgrade: websocket` is passed to the next handler, so an ordinary `GET`
on the same path still reaches the route below the helper.

Hono awaits your event factory before handing the request to the adapter, so the factory
runs on those ordinary requests too. Keep it to returning the handler object; if it does
real work, do that work inside `onOpen`, where it only runs for a connection that opened.

### Running it

`upgradeWebSocket` needs a runtime that provides the upgrade, so a Hono app serving a socket
runs under `neon dev` locally and `neon deploy` in production. Serving it yourself with
`@hono/node-server` will not work — there is no upgrade to claim, and every handshake throws:

```
TypeError: upgradeWebSocket() is only available inside a Neon Functions invocation.
Run your function with `neon dev` locally, or deploy it.
```

Keep `hono` in `dependencies`, not `devDependencies`. `neon deploy` bundles from
`node_modules` and never reads your manifest, so a devDependency deploys fine from a machine
where it happens to be installed — and breaks on a CI that ran `npm ci --omit=dev`, or on a
teammate's fresh clone.

### Types

The subpath exports the types the handlers need, so a factory pulled out of the route does
not have to reach into `hono/ws` or remember the type argument:

```ts
import type { NeonWSEvents, UpgradeWebSocketOptions } from "@neon/functions/hono";

const createEvents = (): NeonWSEvents => ({
	onMessage: (event, ws) => ws.send(`echo: ${event.data}`),
});

const options: UpgradeWebSocketOptions = { protocol: "chat.v2" };
```

`NeonWSEvents` and `NeonWSContext` are Hono's `WSEvents` and `WSContext` with `ws.raw`
already bound to the platform `WebSocket`. Naming Hono's own types without that argument
leaves `ws.raw` as `unknown`.

### The direct form

Hono's other call form works, when you want the context in hand:

```ts
app.get("/ws", (c) => upgradeWebSocket(c, { onMessage: (e, ws) => ws.send(`echo: ${e.data}`) }));
```

**This form is what the `hono` `^4.7.8` requirement is for.** Below that version
`defineWebSocketHelper` implements only the middleware form, so the call returns a
middleware function instead of upgrading. The client gets a 500, nothing reaches `onError`,
and the runtime logs:

```
WebSocket upgrade failed:
TypeError: response.arrayBuffer is not a function
```

npm refuses the install; bun installs it silently and pnpm warns and proceeds, so on those
two the version is yours to check. The middleware form above works on any version that has
the helper at all.

### Subprotocols

Pass `protocol` as the second argument. Nothing is negotiated unless you pass one, and it
must be one the client offered:

```ts
app.get("/ws", upgradeWebSocket(createEvents, { protocol: "chat.v2" }));
```

### Middleware

Gating the route is ordinary middleware — read the token or headers and return before
`next()`:

```ts
app.use("/ws", async (c, next) => {
	if (c.req.query("token") !== expected) return c.text("unauthorized", 401);
	await next();
});
```

**Middleware that touches `c.res` before `await next()`, or calls `c.header()` after it,
breaks the upgrade.** Hono materialises and rebuilds the response in both cases, and
rebuilding the 101 discards the pending upgrade. Reading the request is always fine, and so
is returning your own response before `next()`.

| On an upgrade route | Upgrade survives |
| --- | --- |
| `cors()` | no, at any option including the default |
| reading `c.res` before `await next()`, even without modifying it | no |
| `c.header(...)` after `await next()` | no |
| `secureHeaders()`, `logger()`, `requestId()`, `timing()`, `bodyLimit()` | yes |
| `c.header(...)` before `await next()` | yes, but the header is dropped from the 101 |
| reading `c.res` after `await next()` | yes |

When it breaks, the first thing you see comes from inside Hono and names none of this:

```
RangeError: init["status"] must be in the range of 200 to 599, inclusive.
```

Under `neon dev`, the runtime logs `websocket_upgrade_response_lost` behind it with
the `cors()` / `c.res` / `c.header()` wording from this PR. The deployed runtime
still carries its own copy of that string until it ships separately.

### Lifecycle

A WebSocket is a request that returns a `101`, so it lives under the same rules as any other
Neon Function invocation:

- **Each connection keeps its isolate alive**, and a connection exchanging no bytes for 15
  minutes may be terminated. Protocol ping/pong counts as activity; the runtime answers
  pings without involving your handlers.
- **Isolates are evictable.** In-memory state does not survive, and clients are expected to
  reconnect. Durable state belongs in Postgres.
- **Connections are local to the isolate that accepted them.** A module-scope `Set` of
  connected clients only reaches the clients on that isolate — which is every client under
  `neon dev`, where there is one, and a fraction of them deployed, where there are several.
  Broadcasting across isolates needs an out-of-band channel: Postgres `LISTEN`/`NOTIFY` over
  the unpooled connection to start with, serverless Redis Pub/Sub when the per-isolate idle
  connection becomes the cost.

### Notes

- `ws.raw` is the underlying `WebSocket`, for anything the Hono context does not surface.
- `ws.binaryType` is Hono's own field and does not propagate to the socket. Both default to
  `"arraybuffer"`, so inbound binary arrives as an `ArrayBuffer`; set `ws.raw.binaryType` if
  you need to change it.
- **`ws.send(event.data)` does not type-check.** Hono types inbound data as
  `string | Blob | ArrayBufferLike` while `send` refuses a `Blob`, so echoing the raw value
  back is an error even though the runtime only ever delivers a `string` or an `ArrayBuffer`
  unless you asked for `"blob"`. Interpolate it, or narrow it, before sending it back.
- `SendOptions.compress` is ignored: no extensions are negotiated.
- Importing both helpers into one file needs an alias — the root export and this one share
  the name `upgradeWebSocket`.

## Runtime integration

The runtime publishes the active invocation context on `globalThis.NEON_REQUEST_CONTEXT`
as a getter that returns the live context object directly — `{ waitUntil }` during an
invocation, `undefined` outside one. `waitUntil` reads that value straight off the
global, so there is nothing for application code to wire up.

`upgradeWebSocket` works the same way, reading a bridge the runtime publishes under
`Symbol.for("neon.websocket.bridge")`. All of the protocol work — the handshake, framing,
fragmentation, ping/pong and the close handshake — lives in the runtime; this package is
only a typed facade over it.
