import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A real HTTP server standing in for the gateway, so the provider's request
 * shaping and error handling can be asserted over a real socket instead of a
 * substituted `fetch`. Not exported from the package.
 */
export interface TestGateway {
	/** Base URL to hand to `createNeon`. */
	baseURL: string;
	/** Every request received, in order. */
	requests: ReceivedRequest[];
	close(): Promise<void>;
}

export interface ReceivedRequest {
	method: string;
	path: string;
	body: Record<string, unknown> | undefined;
}

export interface TestGatewayResponse {
	status?: number;
	/** Serialized as JSON unless it is already a string. */
	body: unknown;
	contentType?: string;
	headers?: Record<string, string>;
}

/** Start a gateway that answers every request with `reply`. */
export async function startTestGateway(
	reply: TestGatewayResponse,
): Promise<TestGateway> {
	const requests: ReceivedRequest[] = [];

	const server: Server = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => {
			const raw = Buffer.concat(chunks).toString();
			requests.push({
				method: req.method ?? "",
				path: req.url ?? "",
				body: raw
					? (JSON.parse(raw) as Record<string, unknown>)
					: undefined,
			});
			const payload =
				typeof reply.body === "string"
					? reply.body
					: JSON.stringify(reply.body);
			res.writeHead(reply.status ?? 200, {
				"content-type": reply.contentType ?? "application/json",
				"content-length": String(Buffer.byteLength(payload)),
				...reply.headers,
			});
			res.end(payload);
		});
	});

	await new Promise<void>((resolve) =>
		server.listen(0, "127.0.0.1", resolve),
	);
	const { port } = server.address() as AddressInfo;

	return {
		baseURL: `http://127.0.0.1:${port}`,
		requests,
		close: () =>
			new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			),
	};
}

/** A minimal successful Responses body, enough for the AI SDK to parse. */
export const RESPONSES_OK = {
	id: "resp_test",
	object: "response",
	created_at: 0,
	status: "completed",
	model: "gpt-5-2",
	output: [
		{
			type: "message",
			id: "msg_test",
			role: "assistant",
			status: "completed",
			content: [{ type: "output_text", text: "pong", annotations: [] }],
		},
	],
	usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
};

/** A minimal successful Anthropic Messages body. */
export const MESSAGES_OK = {
	id: "msg_test",
	type: "message",
	role: "assistant",
	model: "claude-opus-5",
	content: [{ type: "text", text: "pong" }],
	stop_reason: "end_turn",
	stop_sequence: null,
	usage: { input_tokens: 1, output_tokens: 1 },
};

/**
 * A minimal successful Anthropic Messages SSE stream. Streaming is the only path
 * that emits `eager_input_streaming`, so the gateway-compat behaviour cannot be
 * asserted against the non-streaming fixture.
 */
export const MESSAGES_STREAM_OK = [
	`event: message_start\ndata: ${JSON.stringify({
		type: "message_start",
		message: {
			id: "msg_test",
			type: "message",
			role: "assistant",
			model: "claude-opus-4-6",
			content: [],
			stop_reason: null,
			stop_sequence: null,
			usage: { input_tokens: 1, output_tokens: 0 },
		},
	})}`,
	`event: content_block_start\ndata: ${JSON.stringify({
		type: "content_block_start",
		index: 0,
		content_block: { type: "text", text: "" },
	})}`,
	`event: content_block_delta\ndata: ${JSON.stringify({
		type: "content_block_delta",
		index: 0,
		delta: { type: "text_delta", text: "pong" },
	})}`,
	`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}`,
	`event: message_delta\ndata: ${JSON.stringify({
		type: "message_delta",
		delta: { stop_reason: "end_turn", stop_sequence: null },
		usage: { output_tokens: 1 },
	})}`,
	`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}`,
	"",
].join("\n\n");

/** A minimal successful Chat Completions body. */
export const CHAT_OK = {
	id: "chatcmpl_test",
	object: "chat.completion",
	created: 0,
	model: "llama-4-maverick",
	choices: [
		{
			index: 0,
			message: { role: "assistant", content: "pong" },
			finish_reason: "stop",
		},
	],
	usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
};
