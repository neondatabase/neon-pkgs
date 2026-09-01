/**
 * The Hono binding for {@link upgrade}, so a route can serve a WebSocket with
 * Hono's own `upgradeWebSocket` helper:
 *
 * ```ts
 * import { Hono } from "hono";
 * import { upgradeWebSocket } from "@neon/functions/hono";
 *
 * const app = new Hono();
 * app.get(
 *   "/ws",
 *   upgradeWebSocket(() => ({
 *     onOpen: (_event, ws) => ws.send("welcome"),
 *     onMessage: (event, ws) => ws.send(`echo: ${event.data}`),
 *   })),
 * );
 * ```
 *
 * It is `defineWebSocketHelper` over the low-level primitive and nothing else:
 * no `ws` dependency, no `@hono/node-ws`, and no protocol code of its own.
 */

import { defineWebSocketHelper, WSContext, type WSReadyState } from "hono/ws";

import {
	type UpgradeWebSocketOptions,
	upgradeWebSocket as upgrade,
} from "./upgrade-websocket.js";

/**
 * `WebSocket.readyState` is typed as `number`, while `WSContext` requires the
 * four-value union. Narrow rather than cast: a fifth value would mean the
 * socket is not the one this adapter was built for, and silently reporting
 * `CLOSED` for it would be a lie Hono then acts on.
 */
const readyStateOf = (socket: WebSocket): WSReadyState => {
	const state = socket.readyState;
	if (state === 0 || state === 1 || state === 2 || state === 3) return state;
	throw new TypeError(
		`WebSocket.readyState was ${state}, which is not a valid ready state.`,
	);
};

/**
 * Serve a WebSocket from a Hono route.
 *
 * Both of Hono's forms work: as route middleware,
 * `app.get("/ws", upgradeWebSocket(createEvents))`, and called directly with a
 * context, `upgradeWebSocket(c, events)`.
 *
 * A request without `Upgrade: websocket` is left alone — the middleware form
 * passes it to the next handler, so an ordinary `GET` on the same path still
 * reaches the route below it.
 *
 * Pass `protocol` to negotiate a subprotocol, exactly as with the low-level
 * helper. Unlike Hono's Deno adapter this never echoes the client's first offer
 * on its own: an un-asked-for subprotocol is one the server has not agreed to
 * speak.
 */
export const upgradeWebSocket = defineWebSocketHelper<
	WebSocket,
	UpgradeWebSocketOptions
>((c, events, options) => {
	if (c.req.header("upgrade")?.toLowerCase() !== "websocket") return;

	const { socket, response } = upgrade(c.req.raw, options);

	const ws = new WSContext<WebSocket>({
		send: (source) => socket.send(source),
		close: (code, reason) => socket.close(code, reason),
		raw: socket,
		get readyState() {
			return readyStateOf(socket);
		},
		url: socket.url,
		protocol: socket.protocol,
	});

	// The socket is still CONNECTING; `open` fires when the runtime writes the
	// 101, which happens because we return `response` below. Listeners must be
	// attached before that.
	socket.onopen = (event) => events.onOpen?.(event, ws);
	socket.onmessage = (event) => events.onMessage?.(event, ws);
	socket.onclose = (event) => events.onClose?.(event, ws);
	socket.onerror = (event) => events.onError?.(event, ws);

	return response;
});
