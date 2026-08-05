/**
 * `@neon/functions` — runtime helpers for Neon Functions.
 *
 * - `waitUntil(promise)` — defers async work past the response by handing the promise to
 *   the current invocation context. No-op off-platform (local dev, tests, non-Neon hosts).
 *   Mirrors `@vercel/functions`.
 * - `upgradeWebSocket(request)` — turns a WebSocket handshake into a live connection from
 *   inside a `fetch` handler, returning `{ socket, response }`. Mirrors
 *   `Deno.upgradeWebSocket`. Throws off-platform, where no socket can be upgraded.
 */

export {
	type UpgradeWebSocketOptions,
	upgradeWebSocket,
	type WebSocketUpgrade,
} from "./lib/upgrade-websocket.js";
export { waitUntil } from "./lib/wait-until.js";
