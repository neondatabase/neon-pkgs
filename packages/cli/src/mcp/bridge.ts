import { createInterface } from "node:readline";
import { USER_AGENT } from "../api.js";
import {
	isEventStreamContentType,
	readSseEvents,
} from "../commands/ask_sse.js";
import { log } from "../log.js";

export type McpBearer = {
	token: () => Promise<string>;
	/** Resolves to a token to retry with after the server answered 401 to `rejected`, or rejects with the message to show. */
	replace: (rejected: string) => Promise<string>;
};

export type McpBridgeOptions = {
	url: string;
	bearer: McpBearer;
	input: NodeJS.ReadableStream;
	output: NodeJS.WritableStream;
};

type JsonRpcId = string | number;

const SESSION_HEADER = "mcp-session-id";
const PROTOCOL_HEADER = "mcp-protocol-version";
const INTERNAL_ERROR = -32603;
const PARSE_ERROR = -32700;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const isId = (value: unknown): value is JsonRpcId =>
	typeof value === "string" || typeof value === "number";

/** Ids of the requests in a message: the ones the client waits on and needs an answer for. */
const requestIds = (message: unknown): JsonRpcId[] =>
	(Array.isArray(message) ? message : [message]).flatMap((item) =>
		isRecord(item) && typeof item.method === "string" && isId(item.id)
			? [item.id]
			: [],
	);

const initializeIds = (message: unknown): JsonRpcId[] =>
	(Array.isArray(message) ? message : [message]).flatMap((item) =>
		isRecord(item) && item.method === "initialize" && isId(item.id)
			? [item.id]
			: [],
	);

const errorDetail = async (response: Response): Promise<string> => {
	const text = (await response.text()).trim();
	try {
		const body: unknown = JSON.parse(text);
		if (isRecord(body)) {
			const error = body.error;
			if (isRecord(error) && typeof error.message === "string") {
				return error.message;
			}
			for (const key of ["error_description", "message", "error"]) {
				if (typeof body[key] === "string") return body[key];
			}
		}
	} catch {
		// Not JSON: the text itself is the detail.
	}
	return text.slice(0, 500);
};

/**
 * Relays newline-delimited JSON-RPC between `input`/`output` (an MCP client's stdio) and a
 * Streamable HTTP MCP server. Resolves once `input` ends and every forwarded message is answered.
 */
export const runMcpBridge = async (
	options: McpBridgeOptions,
): Promise<void> => {
	const { url, bearer, output } = options;
	let sessionId: string | undefined;
	let protocolVersion: string | undefined;
	const pendingInitialize = new Set<JsonRpcId>();

	const write = (message: unknown): void => {
		output.write(`${JSON.stringify(message)}\n`);
	};

	const writeErrors = (ids: JsonRpcId[], message: string): void => {
		for (const id of ids) {
			write({
				jsonrpc: "2.0",
				id,
				error: { code: INTERNAL_ERROR, message },
			});
		}
	};

	const deliver = (message: unknown): void => {
		for (const item of Array.isArray(message) ? message : [message]) {
			if (
				isRecord(item) &&
				isId(item.id) &&
				pendingInitialize.delete(item.id) &&
				isRecord(item.result) &&
				typeof item.result.protocolVersion === "string"
			) {
				protocolVersion = item.result.protocolVersion;
			}
		}
		write(message);
	};

	const post = async (body: string, token: string): Promise<Response> => {
		const headers: Record<string, string> = {
			Accept: "application/json, text/event-stream",
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
			"User-Agent": USER_AGENT,
		};
		if (sessionId) headers[SESSION_HEADER] = sessionId;
		if (protocolVersion) headers[PROTOCOL_HEADER] = protocolVersion;
		try {
			return await fetch(url, { method: "POST", headers, body });
		} catch (err) {
			const cause =
				err instanceof Error &&
				"cause" in err &&
				err.cause instanceof Error
					? err.cause.message
					: err instanceof Error
						? err.message
						: String(err);
			throw new Error(
				`Could not reach the Neon MCP server at ${new URL(url).origin}: ${cause}`,
			);
		}
	};

	const forward = async (message: unknown): Promise<void> => {
		const ids = requestIds(message);
		for (const id of initializeIds(message)) pendingInitialize.add(id);
		const body = JSON.stringify(message);
		try {
			let token = await bearer.token();
			let response = await post(body, token);
			if (response.status === 401) {
				await response.body?.cancel();
				token = await bearer.replace(token);
				response = await post(body, token);
			}
			if (!response.ok) {
				const detail = await errorDetail(response);
				throw new Error(
					`The Neon MCP server answered HTTP ${response.status}${detail ? `: ${detail}` : ""}`,
				);
			}
			sessionId = response.headers.get(SESSION_HEADER) ?? sessionId;
			if (!response.body || response.status === 202) {
				await response.body?.cancel();
				return;
			}
			if (
				isEventStreamContentType(
					response.headers.get("content-type") ?? undefined,
				)
			) {
				for await (const event of readSseEvents(response.body)) {
					if (event.event !== "message" || event.data === "")
						continue;
					deliver(JSON.parse(event.data));
				}
				return;
			}
			const text = await response.text();
			if (text.trim() !== "") deliver(JSON.parse(text));
		} catch (err) {
			const reason = err instanceof Error ? err.message : String(err);
			log.error(reason);
			writeErrors(ids, reason);
		}
	};

	const inFlight = new Set<Promise<void>>();
	const lines = createInterface({
		input: options.input,
		crlfDelay: Number.POSITIVE_INFINITY,
	});
	for await (const line of lines) {
		if (line.trim() === "") continue;
		let message: unknown;
		try {
			message = JSON.parse(line);
		} catch {
			write({
				jsonrpc: "2.0",
				id: null,
				error: {
					code: PARSE_ERROR,
					message: "Parse error: stdin line is not JSON",
				},
			});
			continue;
		}
		const task = forward(message).finally(() => inFlight.delete(task));
		inFlight.add(task);
	}
	await Promise.all(inFlight);
};
