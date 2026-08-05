/**
 * `upgradeWebSocket(request)` turns an incoming WebSocket handshake into a live
 * connection from inside an ordinary `fetch` handler:
 *
 * ```ts
 * const { socket, response } = upgradeWebSocket(request);
 * socket.addEventListener("message", (event) => socket.send(event.data));
 * return response;
 * ```
 *
 * Semantics follow `Deno.upgradeWebSocket`. `socket` is a standard `WebSocket`,
 * still `CONNECTING` when you get it: the runtime writes the `101` only when the
 * handler returns `response`, and the socket opens (firing `open`) at that
 * point. Not returning `response` means the upgrade never completes.
 *
 * Return `response` **unchanged**. A `101` cannot be expressed as a plain
 * `Response` — the fetch spec restricts constructed responses to 200-599 — so
 * the runtime hands back a response object carrying the pending upgrade.
 * Cloning it, or rebuilding it (`new Response(res.body, res)`, which
 * response-rewriting middleware does), discards the upgrade; the runtime detects
 * that and fails the request loudly rather than leaving the client hanging.
 *
 * There is no meaningful degraded WebSocket, so unlike `waitUntil` this throws
 * off-platform instead of silently doing nothing: a socket that could never open
 * is worse than an error that says so.
 */

/** The bridge global the Neon Functions runtime publishes. */
const WS_BRIDGE_KEY = Symbol.for("neon.websocket.bridge");

export interface UpgradeWebSocketOptions {
	/**
	 * The subprotocol to select, echoed back in `Sec-WebSocket-Protocol`.
	 *
	 * Per RFC 6455 §4.2.2 a server may only select a protocol the client
	 * offered, so passing one the client did not offer throws a `TypeError`
	 * rather than producing a handshake the client will reject. Omit it and no
	 * protocol is negotiated: the header is absent and `socket.protocol` is `""`.
	 */
	protocol?: string;
}

export interface WebSocketUpgrade {
	/**
	 * The server side of the connection. `CONNECTING` until the runtime writes
	 * the `101`; `open` fires once it has.
	 *
	 * `binaryType` defaults to `"arraybuffer"` rather than the browser default of
	 * `"blob"`, matching Deno and other server runtimes. `extensions` is always
	 * `""` — no extensions (including `permessage-deflate`) are negotiated.
	 */
	socket: WebSocket;
	/** Return this from `fetch`, unchanged, to complete the upgrade. */
	response: Response;
}

interface WebSocketBridge {
	upgrade(
		request: Request,
		options?: UpgradeWebSocketOptions,
	): WebSocketUpgrade;
}

// The runtime publishes the bridge under a symbol key, which a `declare global`
// cannot describe (global augmentation only names identifiers), so read it
// through an indexed view of `globalThis` instead of a bare cast.
type WebSocketBridgeHost = Record<symbol, WebSocketBridge | undefined>;

/**
 * Upgrade an incoming request to a WebSocket connection.
 *
 * @throws {TypeError} off-platform (no Neon Functions runtime), when the request
 * is not a WebSocket handshake, when called twice for the same request, or when
 * `options.protocol` is not one the client offered.
 */
export function upgradeWebSocket(
	request: Request,
	options?: UpgradeWebSocketOptions,
): WebSocketUpgrade {
	const bridge = (globalThis as unknown as WebSocketBridgeHost)[
		WS_BRIDGE_KEY
	];
	if (!bridge) {
		throw new TypeError(
			"upgradeWebSocket() is only available inside a Neon Functions invocation. " +
				"Run your function with `neon dev` locally, or deploy it.",
		);
	}
	return bridge.upgrade(request, options);
}
