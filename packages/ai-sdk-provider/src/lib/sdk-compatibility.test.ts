import { generateText as generateTextV6, streamText as streamTextV6 } from "ai";
import {
	generateText as generateTextV7,
	streamText as streamTextV7,
} from "ai-v7";
import { describe, expect, it } from "vitest";
import { createNeon } from "./provider.js";

const responseBody = {
	id: "chatcmpl-neon-sdk-compatibility",
	object: "chat.completion",
	created: 0,
	model: "gpt-oss-20b",
	choices: [
		{
			index: 0,
			message: { role: "assistant", content: "pong" },
			finish_reason: "stop",
		},
	],
	usage: {
		prompt_tokens: 1,
		completion_tokens: 1,
		total_tokens: 2,
	},
};

// What the gateway returns for gemini-3-7-flash, gemini-3-8-flash and
// gemini-4-argon on a non-streaming /v1/chat/completions call.
const arrayContentBody = {
	id: null,
	object: "chat.completion",
	created: 0,
	model: "system.ai.gemini-4-argon",
	choices: [
		{
			index: 0,
			message: {
				role: "assistant",
				content: [
					{
						type: "text",
						text: "pong",
						thoughtSignature: "c2lnbmF0dXJl",
					},
				],
			},
			finish_reason: "stop",
		},
	],
	usage: {
		prompt_tokens: 1,
		completion_tokens: 1,
		total_tokens: 2,
	},
};

function createTestProvider(body: object = responseBody) {
	return createNeon({
		baseURL: "https://example.com",
		apiKey: "test-token",
		fetch: async () =>
			new Response(JSON.stringify(body), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
	});
}

function createStreamingTestProvider() {
	const chunks = [
		{
			id: "chatcmpl-neon-sdk-compatibility",
			object: "chat.completion.chunk",
			created: 0,
			model: "gpt-oss-20b",
			choices: [
				{
					index: 0,
					delta: { role: "assistant", content: "pong" },
					finish_reason: null,
				},
			],
		},
		{
			id: "chatcmpl-neon-sdk-compatibility",
			object: "chat.completion.chunk",
			created: 0,
			model: "gpt-oss-20b",
			choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			usage: {
				prompt_tokens: 1,
				completion_tokens: 1,
				total_tokens: 2,
			},
		},
	];
	const body = `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`;

	return createNeon({
		baseURL: "https://example.com",
		apiKey: "test-token",
		fetch: async () =>
			new Response(body, {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			}),
	});
}

describe("AI SDK compatibility", () => {
	it("generates text with AI SDK 6", async () => {
		const result = await generateTextV6({
			model: createTestProvider()("gpt-oss-20b"),
			prompt: "Reply with pong.",
		});

		expect(result.text).toBe("pong");
	});

	it("generates text with AI SDK 7", async () => {
		const result = await generateTextV7({
			model: createTestProvider()("gpt-oss-20b"),
			prompt: "Reply with pong.",
		});

		expect(result.text).toBe("pong");
	});

	it("generates text from array content with AI SDK 6", async () => {
		const result = await generateTextV6({
			model: createTestProvider(arrayContentBody)("gemini-4-argon"),
			prompt: "Reply with pong.",
		});

		expect(result.text).toBe("pong");
	});

	it("generates text from array content with AI SDK 7", async () => {
		const result = await generateTextV7({
			model: createTestProvider(arrayContentBody)("gemini-4-argon"),
			prompt: "Reply with pong.",
		});

		expect(result.text).toBe("pong");
	});

	it("streams text with AI SDK 6", async () => {
		const result = streamTextV6({
			model: createStreamingTestProvider()("gpt-oss-20b"),
			prompt: "Reply with pong.",
		});

		await expect(result.text).resolves.toBe("pong");
	});

	it("streams text with AI SDK 7", async () => {
		const result = streamTextV7({
			model: createStreamingTestProvider()("gpt-oss-20b"),
			prompt: "Reply with pong.",
		});

		await expect(result.text).resolves.toBe("pong");
	});
});
