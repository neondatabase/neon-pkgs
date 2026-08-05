import { afterEach, describe, expect, it, vi } from "vitest";

import {
	type UpgradeWebSocketOptions,
	upgradeWebSocket,
	type WebSocketUpgrade,
} from "./upgrade-websocket.js";

const WS_BRIDGE_KEY = Symbol.for("neon.websocket.bridge");

type BridgeHost = Record<
	symbol,
	| {
			upgrade: (
				request: Request,
				options?: UpgradeWebSocketOptions,
			) => WebSocketUpgrade;
	  }
	| undefined
>;

const host = globalThis as unknown as BridgeHost;

/** Stand in for the runtime's bridge, recording what the facade forwards. */
const installBridge = (
	impl?: (
		request: Request,
		options?: UpgradeWebSocketOptions,
	) => WebSocketUpgrade,
) => {
	const calls: { request: Request; options?: UpgradeWebSocketOptions }[] = [];
	const result = {
		socket: { readyState: 0 } as unknown as WebSocket,
		response: new Response(null, { status: 200 }),
	};
	host[WS_BRIDGE_KEY] = {
		upgrade: (request, options) => {
			calls.push({ request, options });
			return impl ? impl(request, options) : result;
		},
	};
	return { calls, result };
};

const handshake = () =>
	new Request("http://localhost/ws", {
		headers: {
			connection: "Upgrade",
			upgrade: "websocket",
			"sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
			"sec-websocket-version": "13",
		},
	});

afterEach(() => {
	delete host[WS_BRIDGE_KEY];
});

describe("upgradeWebSocket", () => {
	it("returns the runtime's socket and response", () => {
		const { result } = installBridge();
		const upgrade = upgradeWebSocket(handshake());

		expect(upgrade.socket).toBe(result.socket);
		expect(upgrade.response).toBe(result.response);
	});

	it("forwards the request and options to the runtime unchanged", () => {
		const { calls } = installBridge();
		const request = handshake();

		upgradeWebSocket(request, { protocol: "chat.v2" });

		expect(calls).toHaveLength(1);
		expect(calls[0]?.request).toBe(request);
		expect(calls[0]?.options).toEqual({ protocol: "chat.v2" });
	});

	it("passes no options through when none were given", () => {
		const { calls } = installBridge();

		upgradeWebSocket(handshake());

		expect(calls[0]?.options).toBeUndefined();
	});

	it("throws a TypeError off-platform, rather than a socket that never opens", () => {
		expect(() => upgradeWebSocket(handshake())).toThrow(TypeError);
		expect(() => upgradeWebSocket(handshake())).toThrow(
			/only available inside a Neon Functions invocation/,
		);
	});

	it("reads the bridge at call time, so a later-published runtime is picked up", () => {
		expect(() => upgradeWebSocket(handshake())).toThrow(TypeError);

		const { calls } = installBridge();
		upgradeWebSocket(handshake());

		expect(calls).toHaveLength(1);
	});

	it("propagates the runtime's error when the same request is upgraded twice", () => {
		let claimed = false;
		installBridge(() => {
			if (claimed) {
				throw new TypeError(
					"upgradeWebSocket() was already called for this request",
				);
			}
			claimed = true;
			return {
				socket: {} as unknown as WebSocket,
				response: new Response(null),
			};
		});
		const request = handshake();

		upgradeWebSocket(request);

		expect(() => upgradeWebSocket(request)).toThrow(/already called/);
	});

	it("propagates the runtime's error for a subprotocol the client did not offer", () => {
		installBridge((_request, options) => {
			if (options?.protocol === "not-offered") {
				throw new TypeError(
					`the client did not offer the subprotocol "${options.protocol}"`,
				);
			}
			return {
				socket: {} as unknown as WebSocket,
				response: new Response(null),
			};
		});

		expect(() =>
			upgradeWebSocket(handshake(), { protocol: "not-offered" }),
		).toThrow(/did not offer the subprotocol/);
	});

	it("propagates the runtime's error for a request that is not a handshake", () => {
		installBridge(() => {
			throw new TypeError(
				"upgradeWebSocket() requires a WebSocket handshake",
			);
		});

		expect(() =>
			upgradeWebSocket(new Request("http://localhost/not-ws")),
		).toThrow(/requires a WebSocket handshake/);
	});

	it("adds no protocol code of its own: the runtime is the only implementation", () => {
		const upgrade = vi.fn(
			(_request: Request, _options?: UpgradeWebSocketOptions) => ({
				socket: {} as unknown as WebSocket,
				response: new Response(null),
			}),
		);
		host[WS_BRIDGE_KEY] = { upgrade };
		const request = handshake();

		upgradeWebSocket(request, { protocol: "chat.v1" });

		// One delegation, with exactly the arguments the caller passed.
		expect(upgrade).toHaveBeenCalledTimes(1);
		expect(upgrade).toHaveBeenCalledWith(request, { protocol: "chat.v1" });
	});
});
