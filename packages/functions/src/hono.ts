/**
 * `@neon/functions/hono` — the Hono binding for `upgradeWebSocket`.
 *
 * Split from the root entry so importing `@neon/functions` never reaches for
 * `hono`, which is an optional peer.
 */

export { upgradeWebSocket } from "./lib/hono-websocket.js";
