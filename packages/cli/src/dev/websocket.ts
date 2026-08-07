/**
 * WebSocket support for the `neon dev` server.
 *
 * Node's `http.Server` emits `'upgrade'` — not `'request'` — for anything carrying
 * `Connection: Upgrade`. With no `'upgrade'` listener registered, Node routes the
 * handshake to the ordinary request handler, which answers `200 OK` on a connection
 * the client is waiting to see a `101` on. That is why WebSockets did not work under
 * `neon dev`: a function's `upgrade` export was never called, and the client saw a
 * nonsense 200 rather than an error.
 *
 * This module provides both shapes the deployed runtime supports:
 *
 *   1. `export function upgrade(req, socket, head)` — handed the raw Node triple,
 *      exactly like production. The bundle owns the handshake and framing.
 *   2. `upgradeWebSocket(request)` from `@neon/functions`, called inside `fetch` —
 *      reached only when there is no `upgrade` export, matching the runtime's
 *      precedence rule so local behaviour cannot diverge from deployed behaviour.
 *
 * The protocol implementation here mirrors the deployed runtime's. Duplicating it is
 * deliberate for now: the runtime is a zero-dependency file baked into a microVM image
 * and cannot import from npm, so sharing a module would mean new vendoring machinery.
 * The shared contract is the bridge global and the observable behaviour, which the
 * tests on both sides pin. permessage-deflate is not negotiated on either side.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

/** The bridge global `@neon/functions` reads. Must match the deployed runtime. */
const WS_BRIDGE_KEY = Symbol.for("neon.websocket.bridge");

/** Brand identifying the response the helper produced. Non-enumerable. */
const UPGRADE_RECORD = Symbol.for("neon.websocket.upgradeRecord");

/** RFC 6455 §1.3. */
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

const OP_CONTINUATION = 0x0;
const OP_TEXT = 0x1;
const OP_BINARY = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

const CONNECTING = 0;
const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;

/** Reassembly ceiling: a fragmented message buffers until FIN, so it must be bounded. */
const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;
/** Control frames carry at most 125 bytes and are never fragmented (§5.5). */
const MAX_CONTROL_PAYLOAD = 125;
/** A close reason must fit the 123 bytes left after the 2-byte code. */
const MAX_CLOSE_REASON_BYTES = 123;
/** How long to wait for the peer's answering close frame (§7.1.1 leaves this open). */
const CLOSE_HANDSHAKE_TIMEOUT_MS = 5_000;

const EMPTY = Buffer.alloc(0);

/**
 * `MessageEvent` has been global since Node 15, but `CloseEvent` only since Node 23
 * (and even there it disappears under `--no-experimental-websocket`) and `ErrorEvent`
 * only since Node 25. This package supports Node >= 20.19, so both are shimmed with
 * the same shape rather than constructed directly.
 */
type ErrorEventInit = { message?: string; error?: unknown };
type ErrorEventCtorType = new (type: string, init?: ErrorEventInit) => Event;

class ShimErrorEvent extends Event {
	readonly message: string;
	readonly error: unknown;
	constructor(type: string, init: ErrorEventInit = {}) {
		super(type);
		this.message = init.message ?? "";
		this.error = init.error;
	}
}

const ErrorEventCtor: ErrorEventCtorType =
	typeof (globalThis as { ErrorEvent?: unknown }).ErrorEvent === "function"
		? ((globalThis as { ErrorEvent?: unknown })
				.ErrorEvent as ErrorEventCtorType)
		: ShimErrorEvent;

type CloseEventInit = { code?: number; reason?: string; wasClean?: boolean };
type CloseEventCtorType = new (type: string, init?: CloseEventInit) => Event;

class ShimCloseEvent extends Event {
	readonly code: number;
	readonly reason: string;
	readonly wasClean: boolean;
	constructor(type: string, init: CloseEventInit = {}) {
		super(type);
		this.code = init.code ?? 0;
		this.reason = init.reason ?? "";
		this.wasClean = init.wasClean ?? false;
	}
}

export const CloseEventCtor: CloseEventCtorType =
	typeof (globalThis as { CloseEvent?: unknown }).CloseEvent === "function"
		? ((globalThis as { CloseEvent?: unknown })
				.CloseEvent as CloseEventCtorType)
		: ShimCloseEvent;

export type UpgradeWebSocketOptions = {
	protocol?: string;
};

export type WebSocketUpgrade = {
	socket: WebSocket;
	response: Response;
};

/** A raw Node upgrade, as the legacy `upgrade` export receives it. */
export type UpgradeHandler = (
	req: IncomingMessage,
	socket: Duplex,
	head: Buffer,
) => void | Promise<void>;

type UpgradeRecord = {
	req: IncomingMessage;
	socket: Duplex;
	head: Buffer;
	claimed: boolean;
	ws: DevServerWebSocket | null;
	protocol: string;
	accept: string;
};

export const acceptKey = (key: string): string =>
	createHash("sha1")
		.update(key + WS_GUID)
		.digest("base64");

const headerValue = (req: IncomingMessage, name: string): string => {
	const value = req.headers[name];
	if (Array.isArray(value)) return value[0] ?? "";
	return typeof value === "string" ? value : "";
};

/** Does this request carry a WebSocket handshake (rather than some other upgrade)? */
export const isWebSocketHandshake = (req: IncomingMessage): boolean =>
	headerValue(req, "upgrade").toLowerCase() === "websocket" &&
	headerValue(req, "sec-websocket-key") !== "";

// -- Request <-> socket association -----------------------------------------

/** Primary lookup: the exact Request object the dev server built. */
const pendingByRequest = new WeakMap<Request, UpgradeRecord>();

/**
 * Fallback for adapters that rebuild the Request before the handler sees it —
 * Hono's Node adapter does, so the object identity we keyed on is lost.
 */
const upgradeStore = new AsyncLocalStorage<UpgradeRecord>();

const registerUpgrade = (
	request: Request,
	parts: { req: IncomingMessage; socket: Duplex; head: Buffer },
): UpgradeRecord => {
	const record: UpgradeRecord = {
		req: parts.req,
		socket: parts.socket,
		head: parts.head.length ? Buffer.from(parts.head) : EMPTY,
		claimed: false,
		ws: null,
		protocol: "",
		accept: "",
	};
	pendingByRequest.set(request, record);
	return record;
};

const readUpgradeRecord = (value: unknown): UpgradeRecord | null => {
	if (!value || typeof value !== "object") return null;
	return (
		(value as Record<symbol, UpgradeRecord | undefined>)[UPGRADE_RECORD] ??
		null
	);
};

// -- The Response subclass ---------------------------------------------------

/**
 * `new Response(null, { status: 101 })` throws — the fetch spec restricts constructed
 * responses to 200-599. A subclass can still report 101 from the getter while being a
 * genuine `instanceof Response`.
 *
 * The lie does not survive `clone()` or `new Response(res.body, res)`; both drop the
 * brand and the overridden getter. That is detected and failed loudly rather than
 * silently answering 200 on a socket awaiting a 101.
 */
class UpgradeResponse extends Response {
	constructor(record: UpgradeRecord) {
		super(null, { status: 200 });
		Object.defineProperty(this, UPGRADE_RECORD, {
			value: record,
			enumerable: false,
			configurable: false,
			writable: false,
		});
	}

	override get status(): number {
		return 101;
	}

	override get statusText(): string {
		return "Switching Protocols";
	}

	override get ok(): boolean {
		return false;
	}
}

// -- The public helper -------------------------------------------------------

/** The implementation behind `upgradeWebSocket()` in `@neon/functions`. */
export const upgradeWebSocket = (
	request: Request,
	options: UpgradeWebSocketOptions = {},
): WebSocketUpgrade => {
	const record = pendingByRequest.get(request) ?? upgradeStore.getStore();
	if (!record) {
		throw new TypeError(
			"upgradeWebSocket() found no connection to upgrade. It is only usable " +
				"inside a Neon Functions invocation, on a request carrying a WebSocket " +
				"handshake.",
		);
	}
	if (record.claimed) {
		throw new TypeError(
			"upgradeWebSocket() was already called for this request; a connection " +
				"can only be upgraded once.",
		);
	}

	const req = record.req;
	const method = (req.method ?? "GET").toUpperCase();
	if (method !== "GET") {
		throw new TypeError(
			`upgradeWebSocket() requires a GET request, got ${method}.`,
		);
	}
	const key = headerValue(req, "sec-websocket-key");
	if (
		headerValue(req, "upgrade").toLowerCase() !== "websocket" ||
		key === ""
	) {
		throw new TypeError(
			"upgradeWebSocket() requires a WebSocket handshake: the request must " +
				"carry `Upgrade: websocket` and `Sec-WebSocket-Key`.",
		);
	}
	const version = headerValue(req, "sec-websocket-version");
	if (version !== "" && version !== "13") {
		throw new TypeError(
			`unsupported Sec-WebSocket-Version ${version}; only version 13 is supported.`,
		);
	}

	// RFC 6455 §4.2.2: echo exactly one protocol, and only one the client offered.
	// Selecting an un-offered protocol is a server bug that surfaces as an opaque
	// client-side rejection, so fail here where the cause is obvious.
	let protocol = "";
	if (options.protocol != null) {
		if (typeof options.protocol !== "string") {
			throw new TypeError("options.protocol must be a string.");
		}
		const offered = headerValue(req, "sec-websocket-protocol")
			.split(",")
			.map((entry) => entry.trim())
			.filter((entry) => entry !== "");
		if (!offered.includes(options.protocol)) {
			throw new TypeError(
				`the client did not offer the subprotocol "${options.protocol}" ` +
					`(offered: ${offered.length ? offered.join(", ") : "none"}).`,
			);
		}
		protocol = options.protocol;
	}

	record.claimed = true;
	record.protocol = protocol;
	record.accept = acceptKey(key);
	record.ws = new DevServerWebSocket({
		socket: record.socket,
		url: socketUrl(req),
		protocol,
	});
	return {
		socket: record.ws as unknown as WebSocket,
		response: new UpgradeResponse(record),
	};
};

const socketUrl = (req: IncomingMessage): string => {
	const host = headerValue(req, "host") || "localhost";
	const target =
		typeof req.url === "string" && req.url.startsWith("/") ? req.url : "/";
	return `ws://${host}${target}`;
};

/** Publish the bridge so `@neon/functions` resolves under `neon dev`. */
export const installWebSocketBridge = (target: object = globalThis): void => {
	Object.defineProperty(target, WS_BRIDGE_KEY, {
		value: { version: 1, upgrade: upgradeWebSocket },
		enumerable: false,
		configurable: true,
		writable: true,
	});
};

// -- Handshake completion ----------------------------------------------------

/** Headers the handshake owns; a customer value must not override them. */
const RESERVED_HANDSHAKE_HEADERS = new Set([
	"connection",
	"upgrade",
	"sec-websocket-accept",
	"sec-websocket-protocol",
	"sec-websocket-extensions",
	"content-length",
	"content-type",
	"transfer-encoding",
]);

const completeUpgrade = (record: UpgradeRecord, response: Response): void => {
	const socket = record.socket;
	const ws = record.ws;
	if (!ws) return;
	// close() was called before the handler returned: never write the 101.
	if (ws.readyState === CLOSED) {
		try {
			socket.end();
		} catch {
			/* already gone */
		}
		return;
	}
	let head =
		"HTTP/1.1 101 Switching Protocols\r\n" +
		"upgrade: websocket\r\n" +
		"connection: Upgrade\r\n" +
		`sec-websocket-accept: ${record.accept}\r\n`;
	if (record.protocol) {
		head += `sec-websocket-protocol: ${record.protocol}\r\n`;
	}
	try {
		response.headers.forEach((value, name) => {
			const lower = name.toLowerCase();
			if (RESERVED_HANDSHAKE_HEADERS.has(lower)) return;
			head += `${lower}: ${value}\r\n`;
		});
	} catch {
		// A response without usable headers is not a reason to drop the upgrade.
	}
	socket.write(`${head}\r\n`);
	// A live WebSocket is a long-lived idle-tolerant pipe: no inactivity timeout, and
	// no Nagle delay on small frames. `Duplex` does not declare either method, so
	// feature-detect (a test double may implement neither).
	try {
		const tunable = socket as Partial<{
			setTimeout: (ms: number) => void;
			setNoDelay: (enable: boolean) => void;
		}>;
		tunable.setTimeout?.(0);
		tunable.setNoDelay?.(true);
	} catch {
		/* not a real socket */
	}
	ws.openWithHead(record.head);
};

// -- Reject / relay helpers --------------------------------------------------

const STATUS_TEXT: Record<number, string> = {
	200: "OK",
	400: "Bad Request",
	401: "Unauthorized",
	403: "Forbidden",
	404: "Not Found",
	405: "Method Not Allowed",
	409: "Conflict",
	426: "Upgrade Required",
	429: "Too Many Requests",
	500: "Internal Server Error",
	501: "Not Implemented",
	502: "Bad Gateway",
	503: "Service Unavailable",
};

/**
 * Answer an upgrade with a plain HTTP response and close. Node gives us a raw socket
 * for `'upgrade'` (no ServerResponse), so the bytes are written by hand. Always ends
 * the socket: an unanswered upgrade socket leaks and leaves the client hanging.
 */
export const writeUpgradeRejection = (
	socket: Duplex,
	status: number,
	reason: string,
	extraHeaders: Record<string, string> = {},
): void => {
	const body = `${reason}\n`;
	let head =
		`HTTP/1.1 ${status} ${STATUS_TEXT[status] ?? "Error"}\r\n` +
		"connection: close\r\n" +
		"content-type: text/plain\r\n" +
		`content-length: ${Buffer.byteLength(body)}\r\n`;
	for (const [name, value] of Object.entries(extraHeaders)) {
		head += `${name.toLowerCase()}: ${value}\r\n`;
	}
	try {
		socket.end(`${head}\r\n${body}`);
	} catch {
		try {
			socket.destroy();
		} catch {
			/* already destroyed */
		}
	}
};

/** Headers the raw writer owns; a handler value must not contradict them. */
const RESERVED_RESPONSE_HEADERS = new Set([
	"connection",
	"content-length",
	"transfer-encoding",
	"keep-alive",
	"upgrade",
]);

/**
 * Write a `Response` the handler returned to decline the upgrade, verbatim: status,
 * headers and body. Declining a handshake with a 401/403/404 is how a function refuses
 * a connection, so the response has to reach the client instead of being replaced.
 */
const writeResponseToSocket = async (
	socket: Duplex,
	response: Response,
): Promise<void> => {
	const body = Buffer.from(await response.arrayBuffer());
	const statusText =
		response.statusText || (STATUS_TEXT[response.status] ?? "");
	let head = `HTTP/1.1 ${response.status} ${statusText}\r\n`;
	response.headers.forEach((value, name) => {
		if (RESERVED_RESPONSE_HEADERS.has(name.toLowerCase())) return;
		head += `${name.toLowerCase()}: ${value}\r\n`;
	});
	head += "connection: close\r\n";
	head += `content-length: ${body.length}\r\n\r\n`;
	socket.end(Buffer.concat([Buffer.from(head, "latin1"), body]));
};

/** RFC 6455 §4.1: a 16-byte nonce, base64-encoded. */
const isValidWebSocketKey = (key: string): boolean =>
	/^[A-Za-z0-9+/]{22}==$/.test(key) &&
	Buffer.from(key, "base64").length === 16;

type HandshakeRejection = {
	status: number;
	reason: string;
	headers?: Record<string, string>;
};

/**
 * Check the parts of the handshake the server owns before any user code runs, so a
 * malformed client request is answered as the client error it is rather than
 * surfacing later as a throw from `upgradeWebSocket()` (which the listener cannot
 * tell apart from a genuine handler bug, and would report as a 502).
 */
export const validateHandshake = (
	req: IncomingMessage,
): HandshakeRejection | null => {
	const method = (req.method ?? "GET").toUpperCase();
	if (method !== "GET") {
		return {
			status: 405,
			reason: `a WebSocket handshake must use GET, got ${method}`,
		};
	}
	const version = headerValue(req, "sec-websocket-version");
	if (version !== "13") {
		return {
			status: 426,
			reason: `unsupported Sec-WebSocket-Version ${version === "" ? "(absent)" : version}; only version 13 is supported`,
			// §4.4 requires advertising what the server does support.
			headers: { "sec-websocket-version": "13" },
		};
	}
	if (!isValidWebSocketKey(headerValue(req, "sec-websocket-key"))) {
		return {
			status: 400,
			reason: "Sec-WebSocket-Key must be a base64-encoded 16-byte value",
		};
	}
	return null;
};

// -- The 'upgrade' listener --------------------------------------------------

export type UpgradeListenerOptions = {
	/** The user's `fetch` handler, already wrapped in the error boundary. */
	fetch: (req: Request) => Response | Promise<Response>;
	/** The user's legacy `upgrade` export, when they have one. */
	upgrade?: UpgradeHandler | undefined;
	/** Where diagnostics go. Defaults to stderr. */
	log?: (message: string) => void;
};

/**
 * Build the `'upgrade'` listener for the dev server.
 *
 * Precedence matches the deployed runtime exactly: a legacy `upgrade` export wins
 * unconditionally, and only in its absence is the upgrade routed through `fetch` so
 * `upgradeWebSocket()` can claim it. A function that does neither gets a clean 501
 * rather than the misleading 200 Node produces with no listener at all.
 */
export const createUpgradeListener = ({
	fetch: fetchHandler,
	upgrade,
	log = (message) => process.stderr.write(`${message}\n`),
}: UpgradeListenerOptions) => {
	return (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
		void handleUpgrade(req, socket, head, {
			fetch: fetchHandler,
			upgrade,
			log,
		}).catch((err: unknown) => {
			const message =
				err instanceof Error ? (err.stack ?? err.message) : String(err);
			log(`WebSocket upgrade failed:\n${message}`);
			try {
				writeUpgradeRejection(socket, 500, "upgrade error");
			} catch {
				/* socket already gone */
			}
		});
	};
};

const handleUpgrade = async (
	req: IncomingMessage,
	socket: Duplex,
	head: Buffer,
	{
		fetch: fetchHandler,
		upgrade,
		log,
	}: Required<Pick<UpgradeListenerOptions, "fetch" | "log">> & {
		upgrade?: UpgradeHandler | undefined;
	},
): Promise<void> => {
	// A non-WebSocket upgrade (h2c, or something bespoke) is not ours to answer.
	if (!isWebSocketHandshake(req) && !upgrade) {
		writeUpgradeRejection(socket, 426, "expected a websocket upgrade");
		return;
	}

	// The launched contract wins, so local precedence matches deployed precedence.
	// It owns its own handshake, so it is handed the request unvalidated.
	if (upgrade) {
		await upgrade(req, socket, head);
		return;
	}

	const rejection = validateHandshake(req);
	if (rejection) {
		writeUpgradeRejection(
			socket,
			rejection.status,
			rejection.reason,
			rejection.headers ?? {},
		);
		return;
	}

	const request = toWebRequest(req);
	const record = registerUpgrade(request, { req, socket, head });

	let response: Response;
	try {
		response = await upgradeStore.run(record, () => fetchHandler(request));
	} catch (err) {
		const message =
			err instanceof Error ? (err.stack ?? err.message) : String(err);
		log(`Request handler threw an error while upgrading:\n${message}`);
		abortClaimedUpgrade(record);
		writeUpgradeRejection(socket, 502, "handler error");
		return;
	}

	if (readUpgradeRecord(response) === record) {
		completeUpgrade(record, response);
		return;
	}

	if (record.claimed) {
		// upgradeWebSocket() ran, but its response never made it back intact.
		log(
			"websocket_upgrade_response_lost: upgradeWebSocket() was called for this " +
				"request but the response returned from the handler is not the one it " +
				"produced. `Response.clone()` and rebuilding a response " +
				"(`new Response(res.body, res)`, as response-rewriting middleware does) " +
				"both discard the upgrade. Return the `response` from upgradeWebSocket() " +
				"unchanged.\n" +
				"Using @neon/functions/hono? You never touch the response, so this is a " +
				"middleware on the upgrade route rebuilding it: `cors()` always does, and " +
				"so does any middleware that reads `c.res` before `await next()` or calls " +
				"`c.header()` after it. Take it off this route. It usually surfaces first " +
				'as `RangeError: init["status"] must be in the range of 200 to 599` from ' +
				"inside Hono, which names none of this.",
		);
		abortClaimedUpgrade(record);
		writeUpgradeRejection(socket, 500, "websocket_upgrade_response_lost");
		return;
	}

	// The handler declined the upgrade and answered with an ordinary response.
	// Relay it verbatim: returning a 401/403/404 is how a function refuses a
	// handshake, and replacing it with a status of our own would throw away the
	// only answer the client was given.
	await writeResponseToSocket(socket, response);
};

/**
 * The handler claimed the connection but we cannot honour it. Move the socket object
 * to CLOSED so a customer holding it sees a close event instead of one stuck at
 * CONNECTING — without touching the underlying socket, which still needs to carry an
 * HTTP error response.
 */
const abortClaimedUpgrade = (record: UpgradeRecord): void => {
	try {
		record.ws?.abort(1011, "upgrade failed");
	} catch {
		/* best effort */
	}
};

/**
 * Build a Web `Request` from the Node upgrade. A handshake is a GET with no body, so
 * there is nothing to stream — which is just as well, since the socket has already been
 * detached from the HTTP parser.
 */
const toWebRequest = (req: IncomingMessage): Request => {
	const host = headerValue(req, "host") || "localhost";
	const target =
		typeof req.url === "string" && req.url.startsWith("/") ? req.url : "/";
	const headers = new Headers();
	for (const [name, value] of Object.entries(req.headers)) {
		// HTTP/2 pseudo-headers are not valid Header names.
		if (name.startsWith(":")) continue;
		if (Array.isArray(value)) {
			for (const entry of value) headers.append(name, entry);
		} else if (value != null) {
			headers.set(name, value);
		}
	}
	return new Request(`http://${host}${target}`, {
		method: req.method ?? "GET",
		headers,
	});
};

// -- The WHATWG-shaped socket ------------------------------------------------

type HandlerName = "open" | "message" | "close" | "error";

/**
 * A WHATWG `WebSocket` over an already-upgraded Node socket.
 *
 * Two deliberate divergences from a browser, both matching the deployed runtime:
 * `binaryType` defaults to `"arraybuffer"` rather than `"blob"`, and `bufferedAmount`
 * is what we have written and not yet seen flushed, which approximates rather than
 * matches a browser's accounting.
 */
class DevServerWebSocket extends EventTarget {
	static readonly CONNECTING = CONNECTING;
	static readonly OPEN = OPEN;
	static readonly CLOSING = CLOSING;
	static readonly CLOSED = CLOSED;

	readonly url: string;

	#socket: Duplex;
	#protocol: string;
	#readyState: number = CONNECTING;
	#binaryType: "arraybuffer" | "blob" = "arraybuffer";
	#bufferedAmount = 0;
	#chunks: Buffer[] = [];
	#queued = 0;
	#fragmentOpcode = 0;
	#fragments: Buffer[] = [];
	#fragmentBytes = 0;
	#closeSent = false;
	#closeTimer: NodeJS.Timeout | null = null;
	#handlers: Record<HandlerName, EventListener | null> = {
		open: null,
		message: null,
		close: null,
		error: null,
	};

	constructor({
		socket,
		url,
		protocol,
	}: {
		socket: Duplex;
		url: string;
		protocol: string;
	}) {
		super();
		this.#socket = socket;
		this.url = url;
		this.#protocol = protocol;
	}

	get CONNECTING(): number {
		return CONNECTING;
	}
	get OPEN(): number {
		return OPEN;
	}
	get CLOSING(): number {
		return CLOSING;
	}
	get CLOSED(): number {
		return CLOSED;
	}

	get protocol(): string {
		return this.#protocol;
	}
	get extensions(): string {
		return "";
	}
	get readyState(): number {
		return this.#readyState;
	}
	get bufferedAmount(): number {
		return this.#bufferedAmount;
	}

	get binaryType(): "arraybuffer" | "blob" {
		return this.#binaryType;
	}
	set binaryType(value: "arraybuffer" | "blob") {
		if (value !== "arraybuffer" && value !== "blob") {
			throw new DOMException(
				`binaryType must be "arraybuffer" or "blob", got "${String(value)}"`,
				"SyntaxError",
			);
		}
		this.#binaryType = value;
	}

	get onopen(): EventListener | null {
		return this.#handlers.open;
	}
	set onopen(fn: EventListener | null) {
		this.#setHandler("open", fn);
	}
	get onmessage(): EventListener | null {
		return this.#handlers.message;
	}
	set onmessage(fn: EventListener | null) {
		this.#setHandler("message", fn);
	}
	get onclose(): EventListener | null {
		return this.#handlers.close;
	}
	set onclose(fn: EventListener | null) {
		this.#setHandler("close", fn);
	}
	get onerror(): EventListener | null {
		return this.#handlers.error;
	}
	set onerror(fn: EventListener | null) {
		this.#setHandler("error", fn);
	}

	#setHandler(type: HandlerName, fn: EventListener | null): void {
		const previous = this.#handlers[type];
		if (previous) this.removeEventListener(type, previous);
		this.#handlers[type] = typeof fn === "function" ? fn : null;
		const next = this.#handlers[type];
		if (next) this.addEventListener(type, next);
	}

	send(data: string | ArrayBufferLike | ArrayBufferView | Blob): void {
		if (this.#readyState === CONNECTING) {
			throw new DOMException(
				"cannot send() while the WebSocket is still CONNECTING; wait for the " +
					"open event (the socket opens once the handler returns the upgrade response)",
				"InvalidStateError",
			);
		}
		// Per spec, sending on a closing/closed socket is counted and discarded.
		if (typeof data === "string") {
			const payload = Buffer.from(data, "utf8");
			if (this.#readyState !== OPEN) {
				this.#bufferedAmount += payload.length;
				return;
			}
			this.#writeFrame(OP_TEXT, payload);
			return;
		}
		if (data instanceof Blob) {
			// Blobs read asynchronously; chain on the read so ordering holds.
			const size = data.size;
			this.#bufferedAmount += size;
			data.arrayBuffer()
				.then((buf) => {
					this.#bufferedAmount -= size;
					if (this.#readyState === OPEN) {
						this.#writeFrame(OP_BINARY, Buffer.from(buf));
					}
				})
				.catch(() => {
					this.#bufferedAmount -= size;
				});
			return;
		}
		const payload = toBuffer(data);
		if (payload === null) {
			throw new TypeError(
				"send() accepts a string, ArrayBuffer, TypedArray, DataView, or Blob",
			);
		}
		if (this.#readyState !== OPEN) {
			this.#bufferedAmount += payload.length;
			return;
		}
		this.#writeFrame(OP_BINARY, payload);
	}

	close(code?: number, reason?: string): void {
		if (code !== undefined && !isValidCloseCode(code)) {
			throw new DOMException(
				`close code ${code} is not allowed; use 1000 or a code in 3000-4999`,
				"InvalidAccessError",
			);
		}
		let reasonBuf = EMPTY;
		if (reason !== undefined && reason !== null) {
			reasonBuf = Buffer.from(String(reason), "utf8");
			if (reasonBuf.length > MAX_CLOSE_REASON_BYTES) {
				throw new DOMException(
					`close reason must be at most ${MAX_CLOSE_REASON_BYTES} bytes of UTF-8`,
					"SyntaxError",
				);
			}
		}
		if (this.#readyState === CLOSING || this.#readyState === CLOSED) return;
		if (this.#readyState === CONNECTING) {
			// Nothing to close yet — the handshake has not been written.
			this.abort(code ?? 1000, reasonBuf.toString("utf8"));
			return;
		}
		this.#readyState = CLOSING;
		this.#sendClose(code ?? 1000, reasonBuf);
		this.#closeTimer = setTimeout(() => {
			// The peer never answered, so no close frame was received: §7.1.5 makes
			// that 1006, not the code we sent.
			this.#finishClose(1006, "", false);
		}, CLOSE_HANDSHAKE_TIMEOUT_MS);
		this.#closeTimer.unref?.();
	}

	// -- dev-server internal ---------------------------------------------

	/** Called once the 101 is on the wire. */
	openWithHead(head: Buffer): void {
		if (this.#readyState !== CONNECTING) return;
		const socket = this.#socket;
		socket.on("data", (chunk: Buffer) => this.#onData(chunk));
		socket.on("error", (err: Error) => {
			this.#emitError(err);
			this.#finishClose(1006, "", false);
		});
		socket.on("close", () => this.#finishClose(1006, "", false));
		socket.on("end", () => this.#finishClose(1006, "", false));
		this.#readyState = OPEN;
		this.dispatchEvent(new Event("open"));
		if (head.length) this.#onData(head);
	}

	/**
	 * Give up before the handshake was written. Fires `close` so a caller holding the
	 * socket is not left with something stuck at CONNECTING, but deliberately does not
	 * touch the underlying socket: an HTTP error response still has to go out on it.
	 */
	abort(code = 1006, reason = ""): void {
		if (this.#readyState === CLOSED) return;
		this.#readyState = CLOSED;
		if (this.#closeTimer) {
			clearTimeout(this.#closeTimer);
			this.#closeTimer = null;
		}
		this.dispatchEvent(
			new CloseEventCtor("close", { code, reason, wasClean: false }),
		);
	}

	#onData(chunk: Buffer): void {
		if (this.#readyState === CLOSED) return;
		this.#chunks.push(chunk);
		this.#queued += chunk.length;
		try {
			this.#parse();
		} catch (err) {
			this.#emitError(err);
			const code = (err as { wsCode?: number }).wsCode ?? 1002;
			this.#fail(code, err instanceof Error ? err.message : String(err));
		}
	}

	#parse(): void {
		for (;;) {
			if (this.#queued < 2) return;
			const b0 = this.#peek(0);
			const b1 = this.#peek(1);
			const fin = (b0 & 0x80) !== 0;
			const rsv = b0 & 0x70;
			const opcode = b0 & 0x0f;
			const masked = (b1 & 0x80) !== 0;
			let length = b1 & 0x7f;
			let headerLen = 2;
			if (length === 126) {
				if (this.#queued < 4) return;
				length = (this.#peek(2) << 8) | this.#peek(3);
				headerLen = 4;
			} else if (length === 127) {
				if (this.#queued < 10) return;
				let big = 0n;
				for (let i = 0; i < 8; i++)
					big = (big << 8n) | BigInt(this.#peek(2 + i));
				if (big > BigInt(MAX_MESSAGE_BYTES)) {
					throw protocolError(1009, "frame too large");
				}
				length = Number(big);
				headerLen = 10;
			}
			if (masked) headerLen += 4;
			if (this.#queued < headerLen + length) return;

			// Validate before consuming, so a rejected frame cannot desync the parser.
			if (rsv !== 0) {
				throw protocolError(
					1002,
					"reserved bits must be clear (no extensions were negotiated)",
				);
			}
			if (!masked)
				throw protocolError(1002, "client frames must be masked");
			const isControl = (opcode & 0x08) !== 0;
			if (isControl) {
				if (!fin) {
					throw protocolError(
						1002,
						"control frames must not be fragmented",
					);
				}
				if (length > MAX_CONTROL_PAYLOAD) {
					throw protocolError(
						1002,
						"control frame payload exceeds 125 bytes",
					);
				}
			}
			if (
				opcode !== OP_CONTINUATION &&
				opcode !== OP_TEXT &&
				opcode !== OP_BINARY &&
				opcode !== OP_CLOSE &&
				opcode !== OP_PING &&
				opcode !== OP_PONG
			) {
				throw protocolError(
					1002,
					`reserved opcode 0x${opcode.toString(16)}`,
				);
			}

			const header = this.#take(headerLen);
			const payload = this.#take(length);
			if (masked) {
				const mask = header.subarray(headerLen - 4, headerLen);
				for (let i = 0; i < payload.length; i++) {
					payload[i] =
						(payload[i] as number) ^ (mask[i & 3] as number);
				}
			}

			if (isControl) {
				this.#handleControl(opcode, payload);
				if (this.#readyState === CLOSED) return;
				continue;
			}

			if (opcode === OP_CONTINUATION) {
				if (this.#fragmentOpcode === 0) {
					throw protocolError(
						1002,
						"continuation frame without a start frame",
					);
				}
				this.#pushFragment(payload);
			} else {
				if (this.#fragmentOpcode !== 0) {
					throw protocolError(
						1002,
						"new data frame while a fragmented message was open",
					);
				}
				if (!fin) {
					this.#fragmentOpcode = opcode;
					this.#pushFragment(payload);
					continue;
				}
				this.#deliver(opcode, payload);
				continue;
			}
			if (fin) {
				const messageOpcode = this.#fragmentOpcode;
				const full =
					this.#fragments.length === 1
						? (this.#fragments[0] as Buffer)
						: Buffer.concat(this.#fragments);
				this.#fragmentOpcode = 0;
				this.#fragments = [];
				this.#fragmentBytes = 0;
				this.#deliver(messageOpcode, full);
			}
		}
	}

	#pushFragment(payload: Buffer): void {
		this.#fragmentBytes += payload.length;
		if (this.#fragmentBytes > MAX_MESSAGE_BYTES) {
			throw protocolError(
				1009,
				`message exceeds the ${MAX_MESSAGE_BYTES} byte limit`,
			);
		}
		// An empty continuation frame is legal and contributes nothing to the
		// message. Dropping it here keeps a flood of them from growing the fragment
		// list without ever moving `#fragmentBytes` toward the limit above.
		if (payload.length === 0) return;
		this.#fragments.push(payload);
	}

	#deliver(opcode: number, payload: Buffer): void {
		if (this.#readyState !== OPEN) return;
		let data: string | ArrayBuffer | Blob;
		if (opcode === OP_TEXT) {
			try {
				data = new TextDecoder("utf-8", { fatal: true }).decode(
					payload,
				);
			} catch {
				throw protocolError(1007, "text frame is not valid UTF-8");
			}
		} else if (this.#binaryType === "blob") {
			// Copy into a plain Uint8Array: a Node Buffer is not a valid BlobPart.
			data = new Blob([new Uint8Array(payload)]);
		} else {
			// A fresh ArrayBuffer, not a view onto our read buffer.
			data = payload.buffer.slice(
				payload.byteOffset,
				payload.byteOffset + payload.byteLength,
			) as ArrayBuffer;
		}
		this.dispatchEvent(
			new MessageEvent("message", { data, origin: this.url }),
		);
	}

	#handleControl(opcode: number, payload: Buffer): void {
		if (opcode === OP_PING) {
			if (this.#readyState === OPEN) this.#writeFrame(OP_PONG, payload);
			return;
		}
		if (opcode === OP_PONG) return;
		let code = 1005;
		let reason = "";
		if (payload.length === 1) {
			throw protocolError(
				1002,
				"close frame payload must be empty or at least 2 bytes",
			);
		}
		if (payload.length >= 2) {
			code = ((payload[0] as number) << 8) | (payload[1] as number);
			if (!isEchoableCloseCode(code)) {
				throw protocolError(1002, `invalid close code ${code}`);
			}
			try {
				reason = new TextDecoder("utf-8", { fatal: true }).decode(
					payload.subarray(2),
				);
			} catch {
				throw protocolError(1007, "close reason is not valid UTF-8");
			}
		}
		if (!this.#closeSent) {
			// Mirror the peer's code (§5.5.1). 1005 must never go on the wire.
			this.#sendClose(code === 1005 ? 1000 : code, EMPTY);
		}
		this.#finishClose(code, reason, true);
	}

	#sendClose(code: number, reasonBuf: Buffer): void {
		if (this.#closeSent) return;
		this.#closeSent = true;
		const payload = Buffer.allocUnsafe(2 + reasonBuf.length);
		payload.writeUInt16BE(code, 0);
		if (reasonBuf.length) reasonBuf.copy(payload, 2);
		this.#writeFrame(OP_CLOSE, payload);
	}

	#fail(code: number, reason: string): void {
		if (this.#readyState === OPEN) {
			const reasonBuf = Buffer.from(
				reason.slice(0, MAX_CLOSE_REASON_BYTES),
				"utf8",
			);
			try {
				this.#sendClose(code, reasonBuf);
			} catch {
				/* socket already gone */
			}
		}
		this.#finishClose(code, reason, false);
	}

	#finishClose(code: number, reason: string, wasClean: boolean): void {
		if (this.#readyState === CLOSED) return;
		this.#readyState = CLOSED;
		if (this.#closeTimer) {
			clearTimeout(this.#closeTimer);
			this.#closeTimer = null;
		}
		this.#chunks = [];
		this.#queued = 0;
		this.#fragments = [];
		this.#fragmentBytes = 0;
		try {
			this.#socket.end();
		} catch {
			try {
				this.#socket.destroy();
			} catch {
				/* already gone */
			}
		}
		this.dispatchEvent(
			new CloseEventCtor("close", { code, reason, wasClean }),
		);
	}

	#emitError(err: unknown): void {
		const message = err instanceof Error ? err.message : String(err);
		this.dispatchEvent(
			new ErrorEventCtor("error", { message, error: err }),
		);
	}

	#writeFrame(opcode: number, payload: Buffer): void {
		const frame = encodeFrame(opcode, payload);
		this.#bufferedAmount += frame.length;
		try {
			this.#socket.write(frame, () => {
				this.#bufferedAmount -= frame.length;
				if (this.#bufferedAmount < 0) this.#bufferedAmount = 0;
			});
		} catch (err) {
			this.#bufferedAmount -= frame.length;
			this.#emitError(err);
			this.#finishClose(1006, "", false);
		}
	}

	/** Read a byte without consuming it. */
	#peek(index: number): number {
		let remaining = index;
		for (const chunk of this.#chunks) {
			if (remaining < chunk.length) return chunk[remaining] as number;
			remaining -= chunk.length;
		}
		return 0;
	}

	/** Remove `n` bytes from the queue and return them as one owned Buffer. */
	#take(n: number): Buffer {
		if (n === 0) return EMPTY;
		this.#queued -= n;
		const first = this.#chunks[0] as Buffer;
		if (first.length === n) return this.#chunks.shift() as Buffer;
		if (first.length > n) {
			this.#chunks[0] = first.subarray(n);
			// Copy: the caller unmasks in place and the remainder is still queued.
			return Buffer.from(first.subarray(0, n));
		}
		const out = Buffer.allocUnsafe(n);
		let offset = 0;
		while (offset < n) {
			const chunk = this.#chunks[0] as Buffer;
			const take = Math.min(chunk.length, n - offset);
			chunk.copy(out, offset, 0, take);
			offset += take;
			if (take === chunk.length) this.#chunks.shift();
			else this.#chunks[0] = chunk.subarray(take);
		}
		return out;
	}
}

const encodeFrame = (opcode: number, payload: Buffer): Buffer => {
	const len = payload.length;
	let header: Buffer;
	if (len < 126) {
		header = Buffer.allocUnsafe(2);
		header[1] = len;
	} else if (len < 65536) {
		header = Buffer.allocUnsafe(4);
		header[1] = 126;
		header.writeUInt16BE(len, 2);
	} else {
		header = Buffer.allocUnsafe(10);
		header[1] = 127;
		header.writeBigUInt64BE(BigInt(len), 2);
	}
	header[0] = 0x80 | opcode;
	return Buffer.concat([header, payload]);
};

const toBuffer = (data: ArrayBufferLike | ArrayBufferView): Buffer | null => {
	if (data instanceof ArrayBuffer) return Buffer.from(new Uint8Array(data));
	if (ArrayBuffer.isView(data)) {
		return Buffer.from(
			new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
		);
	}
	return null;
};

/** Codes a server may send (§7.4): 1000, or the private 3000-4999 range. */
const isValidCloseCode = (code: number): boolean =>
	code === 1000 || (Number.isInteger(code) && code >= 3000 && code <= 4999);

/** Codes that may legally appear in a close frame we receive — wider than the above. */
const isEchoableCloseCode = (code: number): boolean => {
	if (!Number.isInteger(code)) return false;
	if (code >= 3000 && code <= 4999) return true;
	return (
		code >= 1000 &&
		code <= 1014 &&
		code !== 1004 &&
		code !== 1005 &&
		code !== 1006
	);
};

const protocolError = (code: number, message: string): Error => {
	const err = new Error(message) as Error & { wsCode: number };
	err.wsCode = code;
	return err;
};
