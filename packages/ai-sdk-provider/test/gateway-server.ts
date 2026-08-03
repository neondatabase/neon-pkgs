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
