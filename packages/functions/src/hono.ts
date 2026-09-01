/**
 * `@neon/functions/hono` — the Hono binding for `upgradeWebSocket`.
 *
 * Split from the root entry so importing `@neon/functions` never reaches for
 * `hono`, which is an optional peer.
 */

import type { WSContext, WSEvents } from "hono/ws";

export type { SendOptions, WSMessageReceive, WSReadyState } from "hono/ws";
export { upgradeWebSocket } from "./lib/hono-websocket.js";
export type { UpgradeWebSocketOptions } from "./lib/upgrade-websocket.js";

/**
 * The event handlers a route hands to `upgradeWebSocket`, with `ws.raw` already
 * bound to the platform `WebSocket`.
 *
 * Naming `WSEvents` yourself without its type argument silently degrades
 * `ws.raw` to `unknown`, so this is re-exported already applied.
 */
export type NeonWSEvents = WSEvents<WebSocket>;

/** The socket handle passed to every event handler. */
export type NeonWSContext = WSContext<WebSocket>;
