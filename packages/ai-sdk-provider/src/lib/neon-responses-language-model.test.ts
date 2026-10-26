import { generateText, streamText } from "ai";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	RESPONSES_OK,
	startTestGateway,
	type TestGateway,
} from "../../test/gateway-server.js";
import { createNeon } from "./provider.js";

// The gpt-6 cases drop temperature and topP, and the AI SDK prints a warning
// for each. `console-fail-test` fails any test that writes to the console, so
// the SDK's own logger is turned off while these run.
const previousLogWarnings = globalThis.AI_SDK_LOG_WARNINGS;
beforeAll(() => {
	globalThis.AI_SDK_LOG_WARNINGS = false;
});
afterAll(() => {
	globalThis.AI_SDK_LOG_WARNINGS = previousLogWarnings;
});

/**
 * The defaults themselves are covered in `neon-responses-options.test.ts`
 * against the pure function. These check the wiring: that both entry points
 * reach it, and that what leaves over a real socket is what it produced.
 */
async function sentBodyFor(
	call: (gateway: TestGateway) => Promise<unknown>,
): Promise<Record<string, unknown>> {
	const gateway = await startTestGateway({ body: RESPONSES_OK });
	try {
		await call(gateway);
		const [request] = gateway.requests;
		if (request?.body === undefined) {
			throw new Error("the gateway received no request body");
		}
		return request.body;
	} finally {
		await gateway.close();
	}
}

const model = (gateway: TestGateway, modelId = "gpt-5-2") =>
	createNeon({ baseURL: gateway.baseURL, apiKey: "test-token" })(modelId);

describe("NeonResponsesLanguageModel", () => {
	it("applies the route's defaults on doGenerate", async () => {
		const sent = await sentBodyFor((gateway) =>
			generateText({ model: model(gateway), prompt: "hi" }),
		);

		expect(sent.store).toBe(false);
		expect(sent.include).toContain("reasoning.encrypted_content");
	});

	it("applies the route's defaults on doStream", async () => {
		const sent = await sentBodyFor(async (gateway) => {
			const result = streamText({ model: model(gateway), prompt: "hi" });
			await result.consumeStream();
		});

		expect(sent.store).toBe(false);
		expect(sent.include).toContain("reasoning.encrypted_content");
	});

	// gpt-6 fails the shared model's `gpt-5` reasoning detection, so without
	// `forceReasoning` it ignored reasoningEffort and sent temperature and topP,
	// which the gateway rejects with a 400.
	it("sends gpt-6 as a reasoning model", async () => {
		const sent = await sentBodyFor((gateway) =>
			generateText({
				model: model(gateway, "gpt-6-sol"),
				system: "Be brief.",
				prompt: "hi",
				temperature: 0.2,
				topP: 0.9,
				providerOptions: { openai: { reasoningEffort: "low" } },
			}),
		);

		expect(sent.reasoning).toEqual({ effort: "low" });
		expect(sent.temperature).toBeUndefined();
		expect(sent.top_p).toBeUndefined();
		expect(sent.include).toContain("reasoning.encrypted_content");
		expect((sent.input as Array<{ role: string }>)[0]?.role).toBe(
			"developer",
		);
	});

	// The gateway accepts temperature at effort `none`, but the shared model's
	// exemption only matches dotted ids such as `gpt-5.4`, so it is still
	// dropped for the dashed ids this gateway uses.
	it("still drops temperature at reasoning effort none", async () => {
		const sent = await sentBodyFor((gateway) =>
			generateText({
				model: model(gateway, "gpt-6-sol"),
				prompt: "hi",
				temperature: 0.2,
				providerOptions: { openai: { reasoningEffort: "none" } },
			}),
		);

		expect(sent.reasoning).toEqual({ effort: "none" });
		expect(sent.temperature).toBeUndefined();
	});

	it("posts to the Responses path", async () => {
		const gateway = await startTestGateway({ body: RESPONSES_OK });
		try {
			await generateText({ model: model(gateway), prompt: "hi" });
		} finally {
			await gateway.close();
		}

		expect(gateway.requests).toHaveLength(1);
		expect(gateway.requests[0]?.method).toBe("POST");
		expect(gateway.requests[0]?.path).toBe("/openai/v1/responses");
	});

	it("leaves a store the shared schema can reject to the shared schema", async () => {
		// `store: z.boolean().nullish()` rejects a string locally, with a type
		// error that says so more precisely than anything this route could.
		const gateway = await startTestGateway({ body: RESPONSES_OK });
		try {
			await expect(
				generateText({
					model: model(gateway),
					prompt: "hi",
					providerOptions: { openai: { store: "yes" } },
				}),
			).rejects.toThrow();

			expect(gateway.requests).toHaveLength(0);
		} finally {
			await gateway.close();
		}
	});

	it("refuses a store the gateway cannot serve, before any request", async () => {
		const gateway = await startTestGateway({ body: RESPONSES_OK });
		try {
			await expect(
				generateText({
					model: model(gateway),
					prompt: "hi",
					providerOptions: { openai: { store: true } },
				}),
			).rejects.toThrow(/not available on the Neon AI Gateway/);

			expect(gateway.requests).toHaveLength(0);
		} finally {
			await gateway.close();
		}
	});
});
