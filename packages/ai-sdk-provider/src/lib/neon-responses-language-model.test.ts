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

	// `false` is the only value this gateway accepts, so anything else is
	// refused before the round trip rather than sent to earn a 400. Quietly
	// forcing it to `false` would be the wrong kind of quiet for a
	// data-retention flag.
	it.each([true, null, "yes"])("rejects store: %o", async (store) => {
		await expect(
			capture("gpt-5-2", { openai: { store: store as never } }),
		).rejects.toThrow(/must be `false` or omitted/);
	});

	it("names the gateway's own error in the rejection", async () => {
		await expect(
			capture("gpt-5-2", { openai: { store: true } }),
		).rejects.toThrow(/Databricks does not support store response/);
	});

	it("accepts an explicit store: false", async () => {
		const { sent } = await capture("gpt-5-2", { openai: { store: false } });

		expect(sent.store).toBe(false);
	});

	it("treats store: undefined as unset and still applies the default", async () => {
		// `{ store: undefined }` serializes identically to `{}`, so it has to
		// behave identically too — otherwise spreading an optional config value
		// silently reinstates the item_reference 502.
		const { sent } = await capture("gpt-5-2", {
			openai: { store: undefined as unknown as boolean },
		});

		expect(sent.store).toBe(false);
	});

	// No `forceReasoning: undefined` case here on purpose. It gets the same
	// treatment as store in the source, but the shared model's own bare-id
	// detection currently recognises both `gpt-5-2` and `databricks-gpt-5-2`,
	// so the default is unobservable and such a test could not fail for the
	// right reason.
	it("respects forceReasoning: false", async () => {
		const { sent } = await capture("gpt-5-2", {
			openai: { forceReasoning: false },
		});

		expect(sent.include).toBeUndefined();
		expect(sent.store).toBe(false);
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
