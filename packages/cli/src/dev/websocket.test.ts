import { createServer, type Server } from "node:http";
import { type AddressInfo, connect, type Socket } from "node:net";
import { upgradeWebSocket as honoUpgradeWebSocket } from "@neon/functions/hono";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
	acceptKey,
	createUpgradeListener,
	installWebSocketBridge,
	isWebSocketHandshake,
	type UpgradeHandler,
	type UpgradeWebSocketOptions,
	type WebSocketUpgrade,
} from "./websocket.js";

const WS_BRIDGE_KEY = Symbol.for("neon.websocket.bridge");

/**
 * Reach the helper the way customer code does — through the bridge global, which is
 * exactly what `upgradeWebSocket` in `@neon/functions` reads. Calling the export
 * directly would skip the contract the two packages actually share.
 */
const upgradeWebSocket = (
	request: Request,
	options?: UpgradeWebSocketOptions,
): WebSocketUpgrade => {
	const bridge = (
		globalThis as unknown as Record<
			symbol,
			| {
					upgrade: (
						req: Request,
						opts?: UpgradeWebSocketOptions,
					) => WebSocketUpgrade;
			  }
			| undefined
		>
	)[WS_BRIDGE_KEY];
	if (!bridge) {
		throw new TypeError(
			"upgradeWebSocket() is only available inside a Neon Functions invocation",
		);
	}
	return bridge.upgrade(request, options);
};

type Frame = {
	fin: boolean;
	opcode: number;
	masked: boolean;
	payload: Buffer;
};

/**
 * A WebSocket client that speaks enough of RFC 6455 to verify the server side:
 * masked client frames, fragmentation, ping/pong and the close handshake.
 */
class WsClient {
	buf = Buffer.alloc(0);
	frames: Frame[] = [];
	closed = false;
	#waiters: {
		resolve: (frame: Frame) => void;
		reject: (err: Error) => void;
	}[] = [];

	constructor(readonly sock: Socket) {
		sock.on("data", (chunk: Buffer) => this.feed(chunk));
		sock.on("close", () => {
			this.closed = true;
			this.#drain();
		});
	}

	feed(chunk: Buffer): void {
		this.buf = Buffer.concat([this.buf, chunk]);
		this.#drain();
	}

	#drain(): void {
		for (;;) {
			const frame = this.#decode();
			if (!frame) break;
			this.frames.push(frame);
		}
		while (this.#waiters.length && this.frames.length) {
			this.#waiters.shift()?.resolve(this.frames.shift() as Frame);
		}
		if (this.closed) {
			while (this.#waiters.length) {
				this.#waiters
					.shift()
					?.reject(new Error("socket closed before a frame arrived"));
			}
		}
	}

	#decode(): Frame | null {
		const b = this.buf;
		if (b.length < 2) return null;
		const fin = ((b[0] as number) & 0x80) !== 0;
		const opcode = (b[0] as number) & 0x0f;
		const masked = ((b[1] as number) & 0x80) !== 0;
		let len = (b[1] as number) & 0x7f;
		let off = 2;
		if (len === 126) {
			if (b.length < off + 2) return null;
			len = b.readUInt16BE(off);
			off += 2;
		} else if (len === 127) {
			if (b.length < off + 8) return null;
			len = Number(b.readBigUInt64BE(off));
			off += 8;
		}
		if (masked) off += 4;
		if (b.length < off + len) return null;
		const payload = Buffer.from(b.subarray(off, off + len));
		this.buf = b.subarray(off + len);
		return { fin, opcode, masked, payload };
	}

	next(): Promise<Frame> {
		const buffered = this.frames.shift();
		if (buffered) return Promise.resolve(buffered);
		if (this.closed)
			return Promise.reject(new Error("socket already closed"));
		return new Promise<Frame>((resolve, reject) => {
			this.#waiters.push({ resolve, reject });
			setTimeout(
				() => reject(new Error("timed out waiting for a frame")),
				2000,
			).unref();
		});
	}

	send(payload: string | Buffer, opcode = 0x1, fin = true): void {
		const body = Buffer.isBuffer(payload)
			? payload
			: Buffer.from(payload, "utf8");
		const mask = Buffer.from([0x12, 0x34, 0x56, 0x78]);
		let header: Buffer;
		if (body.length < 126) {
			header = Buffer.alloc(2);
			header[1] = 0x80 | body.length;
		} else {
			header = Buffer.alloc(4);
			header[1] = 0x80 | 126;
			header.writeUInt16BE(body.length, 2);
		}
		header[0] = (fin ? 0x80 : 0x00) | opcode;
		const masked = Buffer.from(body);
		for (let i = 0; i < masked.length; i++) {
			masked[i] = (masked[i] as number) ^ (mask[i & 3] as number);
		}
		this.sock.write(Buffer.concat([header, mask, masked]));
	}

	/** An unmasked client frame — a protocol violation the server must reject. */
	sendUnmasked(payload: string): void {
		const body = Buffer.from(payload, "utf8");
		this.sock.write(
			Buffer.concat([Buffer.from([0x81, body.length]), body]),
		);
	}

	sendClose(code = 1000, reason = ""): void {
		const reasonBuf = Buffer.from(reason, "utf8");
		const payload = Buffer.alloc(2 + reasonBuf.length);
		payload.writeUInt16BE(code, 0);
		reasonBuf.copy(payload, 2);
		this.send(payload, 0x8);
	}

	destroy(): void {
		this.sock.destroy();
	}
}

let server: Server | null = null;

/** Start a dev server wired exactly as `startRuntime` wires it. */
const start = async (mod: {
	fetch?: (req: Request) => Response | Promise<Response>;
	upgrade?: UpgradeHandler;
	log?: (message: string) => void;
}): Promise<number> => {
	installWebSocketBridge();
	// The raw handler, as `startRuntime` passes it: the error boundary would turn a
	// throw into a 500 Response, which this path cannot tell apart from a handler that
	// declined the upgrade.
	const handler = mod.fetch ?? (() => new Response("no fetch handler"));
	const created = createServer((incoming, outgoing) => {
		outgoing.writeHead(200, { "content-type": "text/plain" });
		outgoing.end("ordinary request handler");
		void incoming;
	});
	created.on(
		"upgrade",
		createUpgradeListener({
			fetch: handler,
			upgrade: mod.upgrade,
			...(mod.log ? { log: mod.log } : {}),
		}),
	);
	server = created;
	return new Promise<number>((resolveListen, reject) => {
		created.once("error", reject);
		created.listen(0, "127.0.0.1", () => {
			resolveListen((created.address() as AddressInfo).port);
		});
	});
};

const CLIENT_KEY = "dGhlIHNhbXBsZSBub25jZQ==";
/** The accept value for CLIENT_KEY, from the RFC's own worked example. */
const EXPECTED_ACCEPT = "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=";

const handshakeRequest = (
	path: string,
	extraHeaders: string,
	upgradeValue = "websocket",
): string =>
	`GET ${path} HTTP/1.1\r\n` +
	"host: localhost\r\n" +
	"connection: Upgrade\r\n" +
	`upgrade: ${upgradeValue}\r\n` +
	"sec-websocket-version: 13\r\n" +
	`sec-websocket-key: ${CLIENT_KEY}\r\n` +
	extraHeaders +
	"\r\n";

/** Handshake, then hand back a framing client once the response head is in. */
const wsHandshake = (
	port: number,
	path = "/ws",
	extraHeaders = "",
	upgradeValue = "websocket",
): Promise<{ client: WsClient; raw: string; sock: Socket }> =>
	new Promise((resolveHandshake, reject) => {
		const sock = connect(port, "127.0.0.1", () => {
			sock.write(handshakeRequest(path, extraHeaders, upgradeValue));
		});
		let head = Buffer.alloc(0);
		const onData = (chunk: Buffer): void => {
			head = Buffer.concat([head, chunk]);
			const end = head.indexOf("\r\n\r\n");
			if (end === -1) return;
			sock.off("data", onData);
			const raw = head.subarray(0, end + 4).toString("utf8");
			const rest = head.subarray(end + 4);
			const client = new WsClient(sock);
			// Frames can share the segment that carried the head.
			if (rest.length) client.feed(rest);
			resolveHandshake({ client, raw, sock });
		};
		sock.on("data", onData);
		sock.on("error", reject);
		sock.setTimeout(2000, () => {
			sock.destroy();
			reject(new Error("wsHandshake timeout"));
		});
	});

/** Handshake and read the whole response, for the rejection paths. */
const wsHandshakeFull = (
	port: number,
	path = "/ws",
	extraHeaders = "",
): Promise<string> =>
	new Promise((resolveFull, reject) => {
		const sock = connect(port, "127.0.0.1", () => {
			sock.write(handshakeRequest(path, extraHeaders));
		});
		const chunks: Buffer[] = [];
		const finish = (): void => {
			resolveFull(Buffer.concat(chunks).toString("utf8"));
		};
		sock.on("data", (c: Buffer) => chunks.push(c));
		sock.on("end", finish);
		sock.on("close", finish);
		sock.on("error", reject);
		sock.setTimeout(2000, () => {
			sock.destroy();
			reject(new Error("wsHandshakeFull timeout"));
		});
	});

afterEach(async () => {
	delete (globalThis as unknown as Record<symbol, unknown>)[WS_BRIDGE_KEY];
	if (server) {
		const toClose = server;
		server = null;
		await new Promise<void>((resolveClose) => {
			toClose.close(() => resolveClose());
		});
	}
});

describe("isWebSocketHandshake", () => {
	it("requires both the upgrade header and a key", () => {
		const req = (headers: Record<string, string>) =>
			({ headers }) as unknown as Parameters<
				typeof isWebSocketHandshake
			>[0];
		expect(
			isWebSocketHandshake(
				req({ upgrade: "websocket", "sec-websocket-key": CLIENT_KEY }),
			),
		).toBe(true);
		expect(isWebSocketHandshake(req({ upgrade: "websocket" }))).toBe(false);
		expect(
			isWebSocketHandshake(
				req({ upgrade: "h2c", "sec-websocket-key": CLIENT_KEY }),
			),
		).toBe(false);
		expect(isWebSocketHandshake(req({}))).toBe(false);
	});
});

describe("acceptKey", () => {
	it("matches the worked example in RFC 6455", () => {
		expect(acceptKey(CLIENT_KEY)).toBe(EXPECTED_ACCEPT);
	});
});

describe("event constructors below the supported Node floor", () => {
	// `CloseEvent` is only global from Node 23, and this package supports >= 20.19,
	// so every close path would throw a ReferenceError there without the shim.
	it("uses a CloseEvent shim when the global is absent", async () => {
		const host = globalThis as { CloseEvent?: unknown };
		const original = host.CloseEvent;
		host.CloseEvent = undefined;
		vi.resetModules();
		try {
			const fresh = await import("./websocket.js");
			const event = new fresh.CloseEventCtor("close", {
				code: 4001,
				reason: "bye",
				wasClean: true,
			});
			expect(event).toBeInstanceOf(Event);
			expect(event.type).toBe("close");
			const shaped = event as Event & {
				code: number;
				reason: string;
				wasClean: boolean;
			};
			expect(shaped.code).toBe(4001);
			expect(shaped.reason).toBe("bye");
			expect(shaped.wasClean).toBe(true);
		} finally {
			host.CloseEvent = original;
			vi.resetModules();
		}
	});
});

describe("the legacy upgrade export under neon dev", () => {
	it("is called with the raw Node triple (previously it never ran at all)", async () => {
		const seen: { url: string | undefined; hasHead: boolean }[] = [];
		const port = await start({
			fetch: () => new Response("fetch-handler-ran"),
			upgrade: (req, socket, head) => {
				seen.push({ url: req.url, hasHead: Buffer.isBuffer(head) });
				socket.write(
					"HTTP/1.1 101 Switching Protocols\r\n" +
						"upgrade: websocket\r\nconnection: Upgrade\r\n" +
						`sec-websocket-accept: ${acceptKey(CLIENT_KEY)}\r\n\r\n`,
				);
				socket.end();
			},
		});

		const raw = await wsHandshakeFull(port, "/chat?room=1");

		expect(raw.startsWith("HTTP/1.1 101")).toBe(true);
		expect(seen).toEqual([{ url: "/chat?room=1", hasHead: true }]);
		// The bug this fixes: the fetch handler answered the handshake with a 200.
		expect(raw).not.toContain("fetch-handler-ran");
	});

	it("wins over upgradeWebSocket, matching the deployed precedence", async () => {
		let legacyRan = false;
		let fetchRan = false;
		const port = await start({
			fetch: (request) => {
				fetchRan = true;
				return upgradeWebSocket(request).response;
			},
			upgrade: (_req, socket) => {
				legacyRan = true;
				socket.end(
					"HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\n\r\n",
				);
			},
		});

		const raw = await wsHandshakeFull(port);

		expect(raw.startsWith("HTTP/1.1 101")).toBe(true);
		expect(legacyRan).toBe(true);
		expect(fetchRan).toBe(false);
	});

	it("closes the socket cleanly when it throws, instead of crashing the process", async () => {
		const logged: string[] = [];
		const port = await start({
			fetch: () => new Response("unused"),
			upgrade: () => {
				throw new Error("boom from the upgrade handler");
			},
			log: (message) => logged.push(message),
		});

		const raw = await wsHandshakeFull(port);

		expect(raw.startsWith("HTTP/1.1 500")).toBe(true);
		expect(logged.join("\n")).toContain("boom from the upgrade handler");
	});
});

describe("upgradeWebSocket under neon dev", () => {
	it("completes the 101 and echoes text, binary, and fragmented messages", async () => {
		const port = await start({
			fetch: (request) => {
				const { socket, response } = upgradeWebSocket(request);
				expect(socket.readyState).toBe(0); // CONNECTING until the response returns
				expect(response.status).toBe(101);
				expect(response instanceof Response).toBe(true);
				socket.addEventListener("message", (event) => {
					socket.send((event as MessageEvent).data);
				});
				return response;
			},
		});

		const { client, raw } = await wsHandshake(port);
		expect(raw.startsWith("HTTP/1.1 101 Switching Protocols")).toBe(true);
		expect(raw.toLowerCase()).toContain(
			`sec-websocket-accept: ${EXPECTED_ACCEPT.toLowerCase()}`,
		);
		expect(raw.toLowerCase()).not.toContain("sec-websocket-extensions");

		client.send("hello");
		let frame = await client.next();
		expect(frame.opcode).toBe(0x1);
		expect(frame.payload.toString("utf8")).toBe("hello");
		expect(frame.masked).toBe(false); // servers never mask

		client.send(Buffer.from([1, 2, 3, 250]), 0x2);
		frame = await client.next();
		expect(frame.opcode).toBe(0x2);
		expect([...frame.payload]).toEqual([1, 2, 3, 250]);

		client.send("frag", 0x1, false);
		client.send("mented", 0x0, true);
		frame = await client.next();
		expect(frame.payload.toString("utf8")).toBe("fragmented");

		// Crosses the 125-byte boundary into the 16-bit extended length.
		const big = "x".repeat(1000);
		client.send(big);
		frame = await client.next();
		expect(frame.payload.toString("utf8")).toBe(big);

		client.destroy();
	});

	it("answers a ping with a pong carrying the same payload", async () => {
		const port = await start({
			fetch: (request) => upgradeWebSocket(request).response,
		});

		const { client } = await wsHandshake(port);
		client.send(Buffer.from("beat"), 0x9);
		const frame = await client.next();

		expect(frame.opcode).toBe(0xa);
		expect(frame.payload.toString("utf8")).toBe("beat");
		client.destroy();
	});

	it("sends code and reason on close and walks readyState", async () => {
		const states: number[] = [];
		let closeEvent: { code: number; wasClean: boolean } | null = null;
		const port = await start({
			fetch: (request) => {
				const { socket, response } = upgradeWebSocket(request);
				socket.addEventListener("open", () => {
					states.push(socket.readyState);
					socket.close(1000, "bye");
					states.push(socket.readyState);
				});
				socket.addEventListener("close", (event) => {
					const e = event as CloseEvent;
					closeEvent = { code: e.code, wasClean: e.wasClean };
				});
				return response;
			},
		});

		const { client } = await wsHandshake(port);
		const frame = await client.next();
		expect(frame.opcode).toBe(0x8);
		expect(frame.payload.readUInt16BE(0)).toBe(1000);
		expect(frame.payload.subarray(2).toString("utf8")).toBe("bye");

		client.sendClose(1000, "bye");
		await new Promise((r) => setTimeout(r, 50));

		expect(states).toEqual([1, 2]); // OPEN -> CLOSING
		expect(closeEvent).toEqual({ code: 1000, wasClean: true });
		client.destroy();
	});

	it("mirrors a client-initiated close and reports it to the handler", async () => {
		let closeEvent: { code: number; reason: string } | null = null;
		const port = await start({
			fetch: (request) => {
				const { socket, response } = upgradeWebSocket(request);
				socket.addEventListener("close", (event) => {
					const e = event as CloseEvent;
					closeEvent = { code: e.code, reason: e.reason };
				});
				return response;
			},
		});

		const { client } = await wsHandshake(port);
		client.sendClose(4001, "client done");
		const frame = await client.next();

		expect(frame.opcode).toBe(0x8);
		expect(frame.payload.readUInt16BE(0)).toBe(4001);
		await new Promise((r) => setTimeout(r, 50));
		expect(closeEvent).toEqual({ code: 4001, reason: "client done" });
		client.destroy();
	});

	it("fails the connection on an unmasked client frame", async () => {
		const port = await start({
			fetch: (request) => upgradeWebSocket(request).response,
		});

		const { client } = await wsHandshake(port);
		client.sendUnmasked("unmasked");
		const frame = await client.next();

		expect(frame.opcode).toBe(0x8);
		expect(frame.payload.readUInt16BE(0)).toBe(1002);
		client.destroy();
	});

	it("echoes a requested-and-offered subprotocol exactly once", async () => {
		let negotiated: string | null = null;
		const port = await start({
			fetch: (request) => {
				const { socket, response } = upgradeWebSocket(request, {
					protocol: "chat.v2",
				});
				negotiated = socket.protocol;
				return response;
			},
		});

		const { client, raw } = await wsHandshake(
			port,
			"/ws",
			"sec-websocket-protocol: chat.v1, chat.v2\r\n",
		);

		const echoed = raw
			.split("\r\n")
			.filter((line) => /^sec-websocket-protocol:/i.test(line));
		expect(echoed).toHaveLength(1);
		expect(echoed[0]).toMatch(/chat\.v2$/);
		expect(negotiated).toBe("chat.v2");
		client.destroy();
	});

	it("omits the header and leaves socket.protocol empty when none was selected", async () => {
		let negotiated: string | null = null;
		const port = await start({
			fetch: (request) => {
				const { socket, response } = upgradeWebSocket(request);
				negotiated = socket.protocol;
				return response;
			},
		});

		const { client, raw } = await wsHandshake(
			port,
			"/ws",
			"sec-websocket-protocol: chat.v1\r\n",
		);

		expect(raw.toLowerCase()).not.toContain("sec-websocket-protocol");
		expect(negotiated).toBe("");
		client.destroy();
	});

	it("throws when asked for a subprotocol the client never offered", async () => {
		let thrown: unknown = null;
		const port = await start({
			fetch: (request) => {
				try {
					return upgradeWebSocket(request, {
						protocol: "not-offered",
					}).response;
				} catch (err) {
					thrown = err;
					throw err;
				}
			},
		});

		const raw = await wsHandshakeFull(
			port,
			"/ws",
			"sec-websocket-protocol: chat.v1\r\n",
		);

		expect(raw.startsWith("HTTP/1.1 502")).toBe(true);
		expect(thrown).toBeInstanceOf(TypeError);
		expect((thrown as Error).message).toMatch(
			/did not offer the subprotocol/,
		);
	});

	it("fails loudly on a cloned response, never a silent 200", async () => {
		const logged: string[] = [];
		const port = await start({
			fetch: (request) => upgradeWebSocket(request).response.clone(),
			log: (message) => logged.push(message),
		});

		const raw = await wsHandshakeFull(port);

		expect(raw.startsWith("HTTP/1.1 500")).toBe(true);
		expect(raw).toContain("websocket_upgrade_response_lost");
		expect(raw).not.toContain("HTTP/1.1 200");
		expect(logged.join("\n")).toContain("websocket_upgrade_response_lost");
	});

	it("throws rather than upgrading the same request twice", async () => {
		let thrown: unknown = null;
		const port = await start({
			fetch: (request) => {
				upgradeWebSocket(request);
				try {
					upgradeWebSocket(request);
				} catch (err) {
					thrown = err;
				}
				return new Response("x");
			},
		});

		await wsHandshakeFull(port);

		expect(thrown).toBeInstanceOf(TypeError);
		expect((thrown as Error).message).toMatch(/already called/);
	});

	it("relays the response verbatim when the handler declines the upgrade", async () => {
		const port = await start({
			fetch: () => new Response("ordinary body"),
		});

		const raw = await wsHandshakeFull(port);

		expect(raw.startsWith("HTTP/1.1 200 OK")).toBe(true);
		expect(raw).toContain("ordinary body");
	});

	it("relays a 401 so a function can refuse an unauthenticated handshake", async () => {
		const port = await start({
			fetch: () =>
				new Response("unauthorized", {
					status: 401,
					headers: { "x-reason": "no-token" },
				}),
		});

		const raw = await wsHandshakeFull(port);

		expect(raw.startsWith("HTTP/1.1 401 Unauthorized")).toBe(true);
		expect(raw.toLowerCase()).toContain("x-reason: no-token");
		expect(raw).toContain("unauthorized");
	});

	it("relays a 404 for an unknown websocket route", async () => {
		const port = await start({
			fetch: () => new Response("no such room", { status: 404 }),
		});

		const raw = await wsHandshakeFull(port);

		expect(raw.startsWith("HTTP/1.1 404 Not Found")).toBe(true);
		expect(raw).toContain("no such room");
	});

	it("finds the socket when the handler is handed a rebuilt Request", async () => {
		// Hono's Node adapter rebuilds the Request, so identity is lost and the
		// AsyncLocalStorage fallback is what keeps the helper working.
		const port = await start({
			fetch: (request) => {
				const rebuilt = new Request(request.url, {
					method: request.method,
					headers: request.headers,
				});
				const { socket, response } = upgradeWebSocket(rebuilt);
				socket.addEventListener("message", (event) => {
					socket.send((event as MessageEvent).data);
				});
				return response;
			},
		});

		const { client, raw } = await wsHandshake(port);
		expect(raw.startsWith("HTTP/1.1 101")).toBe(true);
		client.send("via-rebuilt-request");
		const frame = await client.next();

		expect(frame.payload.toString("utf8")).toBe("via-rebuilt-request");
		client.destroy();
	});

	it("exposes the WHATWG surface: constants, binaryType, and the state guards", async () => {
		const port = await start({
			fetch: (request) => {
				const { socket, response } = upgradeWebSocket(request);
				expect(() => socket.send("too early")).toThrow(
					/still CONNECTING/,
				);
				expect([
					socket.CONNECTING,
					socket.OPEN,
					socket.CLOSING,
					socket.CLOSED,
				]).toEqual([0, 1, 2, 3]);
				expect(socket.extensions).toBe("");
				// Server-side default; browsers default to "blob".
				expect(socket.binaryType).toBe("arraybuffer");
				expect(socket.url).toBe("ws://localhost/ws");
				expect(socket.bufferedAmount).toBe(0);
				socket.binaryType = "blob";
				expect(socket.binaryType).toBe("blob");
				socket.binaryType = "arraybuffer";
				// Only 1000 and 3000-4999 may be sent.
				expect(() => socket.close(1001)).toThrow(/not allowed/);
				expect(() => socket.close(1000, "y".repeat(124))).toThrow(
					/at most 123 bytes/,
				);
				socket.onmessage = (event) => {
					socket.send(`got:${(event as MessageEvent).data}`);
				};
				return response;
			},
		});

		const { client } = await wsHandshake(port);
		client.send("prop-style");
		const frame = await client.next();

		expect(frame.payload.toString("utf8")).toBe("got:prop-style");
		client.destroy();
	});

	it("delivers binary as an ArrayBuffer and text as a string", async () => {
		const seen: (string | undefined)[] = [];
		const port = await start({
			fetch: (request) => {
				const { socket, response } = upgradeWebSocket(request);
				socket.addEventListener("message", (event) => {
					seen.push((event as MessageEvent).data?.constructor?.name);
					socket.send("ack");
				});
				return response;
			},
		});

		const { client } = await wsHandshake(port);
		client.send(Buffer.from([9, 9]), 0x2);
		await client.next();
		client.send("text");
		await client.next();

		expect(seen).toEqual(["ArrayBuffer", "String"]);
		client.destroy();
	});

	it("refuses a non-WebSocket upgrade with 426 rather than hanging", async () => {
		const port = await start({ fetch: () => new Response("unused") });

		const raw = await new Promise<string>((resolveRaw, reject) => {
			const sock = connect(port, "127.0.0.1", () => {
				sock.write(
					"GET / HTTP/1.1\r\nhost: localhost\r\n" +
						"connection: Upgrade\r\nupgrade: h2c\r\n\r\n",
				);
			});
			const chunks: Buffer[] = [];
			sock.on("data", (c: Buffer) => chunks.push(c));
			sock.on("close", () =>
				resolveRaw(Buffer.concat(chunks).toString("utf8")),
			);
			sock.on("error", reject);
			sock.setTimeout(2000, () => {
				sock.destroy();
				reject(new Error("timeout"));
			});
		});

		expect(raw.startsWith("HTTP/1.1 426")).toBe(true);
	});

	it("answers an unsupported version with 426 and advertises version 13", async () => {
		const port = await start({
			fetch: (request) => upgradeWebSocket(request).response,
		});

		const raw = await new Promise<string>((resolveRaw, reject) => {
			const sock = connect(port, "127.0.0.1", () => {
				sock.write(
					"GET /ws HTTP/1.1\r\nhost: localhost\r\n" +
						"connection: Upgrade\r\nupgrade: websocket\r\n" +
						"sec-websocket-version: 8\r\n" +
						`sec-websocket-key: ${CLIENT_KEY}\r\n\r\n`,
				);
			});
			const chunks: Buffer[] = [];
			sock.on("data", (c: Buffer) => chunks.push(c));
			sock.on("close", () =>
				resolveRaw(Buffer.concat(chunks).toString("utf8")),
			);
			sock.on("error", reject);
			sock.setTimeout(2000, () => {
				sock.destroy();
				reject(new Error("timeout"));
			});
		});

		expect(raw.startsWith("HTTP/1.1 426 Upgrade Required")).toBe(true);
		expect(raw.toLowerCase()).toContain("sec-websocket-version: 13");
		// Never a 502: a bad version is the client's error, not the handler's.
		expect(raw).not.toContain("502");
	});

	it("answers a malformed Sec-WebSocket-Key with 400", async () => {
		const port = await start({
			fetch: (request) => upgradeWebSocket(request).response,
		});

		const raw = await new Promise<string>((resolveRaw, reject) => {
			const sock = connect(port, "127.0.0.1", () => {
				sock.write(
					"GET /ws HTTP/1.1\r\nhost: localhost\r\n" +
						"connection: Upgrade\r\nupgrade: websocket\r\n" +
						"sec-websocket-version: 13\r\n" +
						"sec-websocket-key: not-a-valid-key\r\n\r\n",
				);
			});
			const chunks: Buffer[] = [];
			sock.on("data", (c: Buffer) => chunks.push(c));
			sock.on("close", () =>
				resolveRaw(Buffer.concat(chunks).toString("utf8")),
			);
			sock.on("error", reject);
			sock.setTimeout(2000, () => {
				sock.destroy();
				reject(new Error("timeout"));
			});
		});

		expect(raw.startsWith("HTTP/1.1 400 Bad Request")).toBe(true);
	});

	it("answers a non-GET handshake with 405", async () => {
		const port = await start({
			fetch: (request) => upgradeWebSocket(request).response,
		});

		const raw = await new Promise<string>((resolveRaw, reject) => {
			const sock = connect(port, "127.0.0.1", () => {
				sock.write(
					"POST /ws HTTP/1.1\r\nhost: localhost\r\n" +
						"connection: Upgrade\r\nupgrade: websocket\r\n" +
						"sec-websocket-version: 13\r\n" +
						`sec-websocket-key: ${CLIENT_KEY}\r\n\r\n`,
				);
			});
			const chunks: Buffer[] = [];
			sock.on("data", (c: Buffer) => chunks.push(c));
			sock.on("close", () =>
				resolveRaw(Buffer.concat(chunks).toString("utf8")),
			);
			sock.on("error", reject);
			sock.setTimeout(2000, () => {
				sock.destroy();
				reject(new Error("timeout"));
			});
		});

		expect(raw.startsWith("HTTP/1.1 405 Method Not Allowed")).toBe(true);
	});

	it("does not accumulate fragments for a flood of empty continuations", async () => {
		const port = await start({
			fetch: (request) => {
				const { socket, response } = upgradeWebSocket(request);
				socket.addEventListener("message", (event) => {
					socket.send(
						`len:${String((event as MessageEvent).data).length}`,
					);
				});
				return response;
			},
		});

		const { client } = await wsHandshake(port);
		// Open a fragmented text message, then send many empty continuations. Each
		// adds zero bytes, so a byte-only bound would never stop them.
		client.send("", 0x1, false);
		for (let i = 0; i < 20000; i++) client.send("", 0x0, false);
		client.send("done", 0x0, true);

		const frame = await client.next();
		expect(frame.payload.toString("utf8")).toBe("len:4");
		client.destroy();
	});

	it("throws off-platform, where no bridge is published", () => {
		delete (globalThis as unknown as Record<symbol, unknown>)[
			WS_BRIDGE_KEY
		];
		expect(() =>
			upgradeWebSocket(new Request("http://localhost/ws")),
		).toThrow(/only available inside a Neon Functions invocation/);
	});
});

/**
 * The Hono binding, exercised the way a customer gets it: the published
 * `@neon/functions/hono` subpath, a real Hono app, and the same dev runtime
 * over real sockets.
 */
describe("@neon/functions/hono under neon dev", () => {
	it("serves the documented route: welcome, echo, and a client close", async () => {
		const closed: { code: number; reason: string }[] = [];
		const app = new Hono();
		app.get(
			"/ws",
			honoUpgradeWebSocket(() => ({
				onOpen: (_event, ws) => ws.send("welcome"),
				onMessage: (event, ws) => ws.send(`echo: ${event.data}`),
				onClose: (event) =>
					closed.push({ code: event.code, reason: event.reason }),
			})),
		);
		const port = await start({ fetch: app.fetch });

		const { client, raw } = await wsHandshake(port);
		expect(raw.startsWith("HTTP/1.1 101 Switching Protocols")).toBe(true);

		expect((await client.next()).payload.toString("utf8")).toBe("welcome");

		client.send("hi");
		expect((await client.next()).payload.toString("utf8")).toBe("echo: hi");

		client.sendClose(1000, "bye");
		await new Promise((r) => setTimeout(r, 50));
		expect(closed).toEqual([{ code: 1000, reason: "bye" }]);
		client.destroy();
	});

	it("passes an ordinary request to the next handler instead of throwing", async () => {
		const app = new Hono();
		app.get(
			"/ws",
			honoUpgradeWebSocket(() => ({})),
			(c) => c.text("plain get"),
		);

		// No bridge, no upgrade record: the guard must return before the
		// primitive is ever reached, or this is a 500 on every normal GET.
		delete (globalThis as unknown as Record<symbol, unknown>)[
			WS_BRIDGE_KEY
		];
		const response = await app.fetch(new Request("http://localhost/ws"));

		expect(response.status).toBe(200);
		expect(await response.text()).toBe("plain get");
	});

	it("upgrades on a mixed-case Upgrade header", async () => {
		const app = new Hono();
		app.get(
			"/ws",
			honoUpgradeWebSocket(() => ({
				onOpen: (_event, ws) => ws.send("upgraded"),
			})),
		);
		const port = await start({ fetch: app.fetch });

		const { client, raw } = await wsHandshake(port, "/ws", "", "WebSocket");

		expect(raw.startsWith("HTTP/1.1 101 Switching Protocols")).toBe(true);
		expect((await client.next()).payload.toString("utf8")).toBe("upgraded");
		client.destroy();
	});

	it("negotiates an offered subprotocol and reports it on the context", async () => {
		const app = new Hono();
		app.get(
			"/ws",
			honoUpgradeWebSocket(
				() => ({
					onOpen: (_event, ws) => ws.send(`protocol:${ws.protocol}`),
				}),
				{ protocol: "chat.v2" },
			),
		);
		const port = await start({ fetch: app.fetch });

		const { client, raw } = await wsHandshake(
			port,
			"/ws",
			"sec-websocket-protocol: chat.v1, chat.v2\r\n",
		);

		const echoed = raw
			.split("\r\n")
			.filter((line) =>
				line.toLowerCase().startsWith("sec-websocket-protocol:"),
			);
		expect(echoed).toEqual(["sec-websocket-protocol: chat.v2"]);
		expect((await client.next()).payload.toString("utf8")).toBe(
			"protocol:chat.v2",
		);
		client.destroy();
	});

	it("refuses a subprotocol the client never offered, rather than upgrading", async () => {
		const app = new Hono();
		app.get(
			"/ws",
			honoUpgradeWebSocket(() => ({}), { protocol: "not-offered" }),
		);
		const port = await start({ fetch: app.fetch });

		const response = await wsHandshakeFull(port);

		expect(response.startsWith("HTTP/1.1 101")).toBe(false);
	});

	it("lets auth middleware refuse the handshake before any socket exists", async () => {
		let eventsBuilt = 0;
		const app = new Hono();
		app.use("/ws", async (c, next) => {
			if (c.req.query("token") !== "letmein") return c.text("nope", 401);
			await next();
		});
		app.get(
			"/ws",
			honoUpgradeWebSocket(() => {
				eventsBuilt += 1;
				return {};
			}),
		);
		const port = await start({ fetch: app.fetch });

		const rejected = await wsHandshakeFull(port, "/ws");
		expect(rejected.startsWith("HTTP/1.1 401")).toBe(true);
		expect(rejected).toContain("nope");
		expect(eventsBuilt).toBe(0);

		const { client, raw } = await wsHandshake(port, "/ws?token=letmein");
		expect(raw.startsWith("HTTP/1.1 101")).toBe(true);
		expect(eventsBuilt).toBe(1);
		client.destroy();
	});

	it("exposes the raw socket, the ws:// url, and a live readyState", async () => {
		const seen: { url: string | null; raw: boolean; states: number[] } = {
			url: null,
			raw: false,
			states: [],
		};
		const app = new Hono();
		app.get(
			"/ws",
			honoUpgradeWebSocket(() => ({
				onOpen: (_event, ws) => {
					seen.url = ws.url?.toString() ?? null;
					seen.raw = ws.raw instanceof Object && "send" in ws.raw;
					seen.states.push(ws.readyState);
					ws.close(1000, "done");
					seen.states.push(ws.readyState);
				},
			})),
		);
		const port = await start({ fetch: app.fetch });

		const { client } = await wsHandshake(port, "/ws");
		const frame = await client.next();

		expect(frame.opcode).toBe(0x8);
		expect(seen.url).toBe("ws://localhost/ws");
		expect(seen.raw).toBe(true);
		// OPEN then CLOSING: a snapshotted readyState would report 1 twice.
		expect(seen.states).toEqual([1, 2]);
		client.destroy();
	});

	it("delivers binary as an ArrayBuffer and sends a Uint8Array back", async () => {
		const kinds: string[] = [];
		const app = new Hono();
		app.get(
			"/ws",
			honoUpgradeWebSocket(() => ({
				onMessage: (event, ws) => {
					kinds.push(
						event.data instanceof ArrayBuffer
							? "arraybuffer"
							: typeof event.data,
					);
					ws.send(new Uint8Array([7, 8, 9]));
				},
			})),
		);
		const port = await start({ fetch: app.fetch });

		const { client } = await wsHandshake(port);
		client.send(Buffer.from([1, 2, 3]), 0x2);
		const frame = await client.next();

		expect(kinds).toEqual(["arraybuffer"]);
		expect(frame.opcode).toBe(0x2);
		expect([...frame.payload]).toEqual([7, 8, 9]);
		client.destroy();
	});

	it("works in the direct form, called with a context", async () => {
		const app = new Hono();
		app.get("/ws", (c) =>
			honoUpgradeWebSocket(c, {
				onOpen: (_event, ws) => ws.send("direct"),
			}),
		);
		const port = await start({ fetch: app.fetch });

		const { client, raw } = await wsHandshake(port);

		expect(raw.startsWith("HTTP/1.1 101")).toBe(true);
		expect((await client.next()).payload.toString("utf8")).toBe("direct");
		client.destroy();
	});
});
