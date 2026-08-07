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

> **Requirements:** Node.js >= 20.19. The `@neon/functions/hono` subpath needs
> `hono` >= 4.6.10, declared as an optional peer — installing `@neon/functions`
> on its own pulls in nothing and warns about nothing.

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
	upgradeWebSocket((c) => ({
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

Hono's direct form works too, when you want the context in hand:

```ts
app.get("/ws", (c) => upgradeWebSocket(c, { onMessage: (e, ws) => ws.send(e.data) }));
```

A request without `Upgrade: websocket` is passed to the next handler, so an ordinary `GET`
on the same path still reaches the route below the helper.

### Subprotocols

Pass `protocol` as the second argument, with the same rule as the low-level helper — it must
be one the client offered:

```ts
app.get("/ws", upgradeWebSocket(createEvents, { protocol: "chat.v2" }));
```

Unlike Hono's Deno adapter, this never echoes the client's first offer on its own. A
subprotocol the server did not ask for is one it has not agreed to speak.

### Middleware

Gating the route is ordinary middleware — read the token or headers and return before
`next()`:

```ts
app.use("/ws", async (c, next) => {
	if (c.req.query("token") !== expected) return c.text("unauthorized", 401);
	await next();
});
```

**Middleware that modifies the response cannot run on an upgrade route.** CORS is the usual
one. Hono rebuilds `c.res` when middleware touches it, and rebuilding the 101 discards the
pending upgrade — the runtime detects that and fails the request loudly rather than leaving
the client waiting. Middleware that only inspects the request, or returns its own response
before `next()`, is fine.

### Notes

- `ws.raw` is the underlying `WebSocket`, for anything the Hono context does not surface.
- `ws.binaryType` is Hono's own field and does not propagate to the socket. Both default to
  `"arraybuffer"`, so inbound binary arrives as an `ArrayBuffer`; set `ws.raw.binaryType` if
  you need to change it.
- `SendOptions.compress` is ignored: no extensions are negotiated.

## Runtime integration

The runtime publishes the active invocation context on `globalThis.NEON_REQUEST_CONTEXT`
as a getter that returns the live context object directly — `{ waitUntil }` during an
invocation, `undefined` outside one. `waitUntil` reads that value straight off the
global, so there is nothing for application code to wire up.

`upgradeWebSocket` works the same way, reading a bridge the runtime publishes under
`Symbol.for("neon.websocket.bridge")`. All of the protocol work — the handshake, framing,
fragmentation, ping/pong and the close handshake — lives in the runtime; this package is
only a typed facade over it.
