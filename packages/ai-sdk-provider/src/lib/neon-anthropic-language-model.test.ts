import { generateText, streamText, tool } from "ai";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
	MESSAGES_OK,
	MESSAGES_STREAM_OK,
	startTestGateway,
} from "../../test/gateway-server.js";
import { createNeon } from "./provider.js";

// These cases exist to prove a warning is raised, and the AI SDK also prints it.
// `console-fail-test` fails any test that writes to the console, so the SDK's
// own logger is turned off while the assertions read `result.warnings` directly.
const previousLogWarnings = globalThis.AI_SDK_LOG_WARNINGS;
beforeAll(() => {
	globalThis.AI_SDK_LOG_WARNINGS = false;
});
afterAll(() => {
	globalThis.AI_SDK_LOG_WARNINGS = previousLogWarnings;
});

/**
 * The capability rules themselves are covered in
 * `neon-model-capabilities.test.ts` against the pure function. These check the
 * wiring, which a pure test cannot: that the Anthropic route reaches those rules
 * at all.
 *
 * It did not. `applyNeonCapabilities` was called only by the chat model, so
 * `claude-opus-5` and `claude-sonnet-5` forwarded `temperature` to the gateway
 * and came back `` `temperature` is deprecated for this model ``. The older ids
 * appeared to work only because the upstream Anthropic SDK drops sampling for
 * the versions it happens to know about.
 */
async function sentBodyFor(
	modelId: string,
	options: Partial<Record<"temperature" | "topP", number>>,
): Promise<{ body: Record<string, unknown>; warnings: string[] }> {
	const gateway = await startTestGateway({ body: MESSAGES_OK });
	try {
		const model = createNeon({
			baseURL: gateway.baseURL,
			apiKey: "test-token",
		})(modelId);
		const result = await generateText({ model, prompt: "hi", ...options });
		const [request] = gateway.requests;
		if (request?.body === undefined) {
			throw new Error("the gateway received no request body");
		}
		return {
			body: request.body,
			warnings: (result.warnings ?? []).map((w) =>
				"feature" in w ? String(w.feature) : w.type,
			),
		};
	} finally {
		await gateway.close();
	}
}

/**
 * `eager_input_streaming` is only emitted for a streaming call that declares
 * tools, so the gateway-compat behaviour has to be exercised with both.
 */
async function streamedToolBody(
	modelId: string,
	toolStreaming?: boolean,
): Promise<Record<string, unknown>> {
	const gateway = await startTestGateway({
		body: MESSAGES_STREAM_OK,
		contentType: "text/event-stream",
	});
	try {
		const model = createNeon({
			baseURL: gateway.baseURL,
			apiKey: "test-token",
		})(modelId);
		const result = streamText({
			model,
			prompt: "what is the weather in Mountain View?",
			tools: {
				get_weather: tool({
					description: "Get the weather for a city.",
					inputSchema: z.object({ city: z.string() }),
				}),
			},
			...(toolStreaming === undefined
				? {}
				: { providerOptions: { anthropic: { toolStreaming } } }),
		});
		await result.consumeStream();
		const [request] = gateway.requests;
		if (request?.body === undefined) {
			throw new Error("the gateway received no request body");
		}
		return request.body;
	} finally {
		await gateway.close();
	}
}

describe("NeonAnthropicLanguageModel", () => {
	it("strips temperature for Claude 4.7 and newer", async () => {
		const { body, warnings } = await sentBodyFor("claude-opus-5", {
			temperature: 0.2,
		});

		expect(body.temperature).toBeUndefined();
		expect(warnings).toContain("temperature");
	});

	it("strips topP for Claude 4.7 and newer", async () => {
		const { body, warnings } = await sentBodyFor("claude-sonnet-5", {
			topP: 0.9,
		});

		expect(body.top_p).toBeUndefined();
		expect(warnings).toContain("topP");
	});

	it("keeps temperature for Claude 4.6 and earlier", async () => {
		const { body, warnings } = await sentBodyFor("claude-opus-4-6", {
			temperature: 0.2,
		});

		expect(body.temperature).toBe(0.2);
		expect(warnings).not.toContain("temperature");
	});

	it("disables eager tool-input streaming, which the gateway rejects", async () => {
		const body = await streamedToolBody("claude-opus-4-6");

		// The shared Anthropic model would otherwise send this and the gateway
		// answers `Extra inputs are not permitted`.
		expect(body.tools).toBeDefined();
		expect(JSON.stringify(body)).not.toContain("eager_input_streaming");
	});

	it("respects an explicit toolStreaming override", async () => {
		const body = await streamedToolBody("claude-opus-4-6", true);

		expect(JSON.stringify(body)).toContain("eager_input_streaming");
	});
});
