---
"@neon/functions": minor
---

Add `@neon/functions/hono` — `upgradeWebSocket` as a Hono route helper

Serving a WebSocket from a Hono app meant either hand-writing a
`defineWebSocketHelper` adapter over the low-level primitive, or reaching for
`@hono/node-ws`, which is deprecated and pulls in `ws`. The adapter is fifteen
lines that every Hono user would write identically, so it ships first-party:

```ts
import { Hono } from "hono";
import { upgradeWebSocket } from "@neon/functions/hono";

const app = new Hono();

app.get(
	"/ws",
	upgradeWebSocket(() => ({
		onOpen: (_event, ws) => ws.send("welcome"),
		onMessage: (event, ws) => ws.send(`echo: ${event.data}`),
	})),
);

export default app;
```

Both of Hono's forms work — as route middleware, and called directly with a
context. `protocol` selects a subprotocol under the same rule as the low-level
helper: it must be one the client offered, and nothing is negotiated unless you
ask, so the client's first offer is never echoed back on its own.

A request without `Upgrade: websocket` falls through to the next handler, so an
ordinary `GET` on the same path is unaffected.

`hono` is an optional peer (`>=4.6.10`, the first release with
`defineWebSocketHelper`). Installing `@neon/functions` without it installs
nothing extra and warns about nothing; the root entry never reaches for it.
