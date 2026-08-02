import type { SharedV3ProviderOptions } from "@ai-sdk/provider";
import { generateText } from "ai";
import { describe, expect, it } from "vitest";
import { createNeon } from "./provider.js";

const responseBody = {
	id: "resp_neon_test",
	object: "response",
	created_at: 0,
	status: "completed",
	model: "gpt-5-2",
	output: [
		{
			type: "message",
			id: "msg_neon_test",
			role: "assistant",
			status: "completed",
			content: [{ type: "output_text", text: "pong", annotations: [] }],
		},
	],
	usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
};

const chatBody = {
	id: "chatcmpl_neon_test",
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
	usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
};

/** Run one generateText call and return the request body the provider sent. */
async function capture(
	modelId: string,
	providerOptions?: SharedV3ProviderOptions,
) {
	let sent: Record<string, unknown> | undefined;
	let url: string | undefined;
	const neon = createNeon({
		baseURL: "https://example.com",
		apiKey: "test-token",
		fetch: async (input, init) => {
			url = typeof input === "string" ? input : String(input);
			sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
			const body = url.includes("/responses") ? responseBody : chatBody;
			return new Response(JSON.stringify(body), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		},
	});
	await generateText({
		model: neon(modelId),
		prompt: "Reply with pong.",
		...(providerOptions ? { providerOptions } : {}),
	});
	return { sent: sent ?? {}, url: url ?? "" };
}

describe("NeonResponsesLanguageModel gateway defaults", () => {
	it("sends store: false so the gateway never receives an item_reference", async () => {
		const { sent, url } = await capture("gpt-5-2");

		expect(url).toBe("https://example.com/openai/v1/responses");
		expect(sent.store).toBe(false);
	});

	it("asks for inlined reasoning, the only shape a stateless gateway can serve", async () => {
		const { sent } = await capture("gpt-5-2");

		expect(sent.include).toContain("reasoning.encrypted_content");
	});

	it("applies the default on non-GPT-5 models routed to Responses", async () => {
		const { sent } = await capture("gpt-5-3-codex");

		expect(sent.store).toBe(false);
	});

	it("respects an explicit store: true from the caller", async () => {
		const { sent } = await capture("gpt-5-2", { openai: { store: true } });

		expect(sent.store).toBe(true);
	});

	it("keeps other openai provider options alongside the default", async () => {
		const { sent } = await capture("gpt-5-2", {
			openai: { reasoningEffort: "low" },
		});

		expect(sent.store).toBe(false);
		expect(sent.reasoning).toMatchObject({ effort: "low" });
	});

	it("leaves chat-completions models untouched", async () => {
		const { sent, url } = await capture("gpt-oss-20b");

		expect(url).toBe("https://example.com/v1/chat/completions");
		expect(sent).not.toHaveProperty("store");
	});
});
