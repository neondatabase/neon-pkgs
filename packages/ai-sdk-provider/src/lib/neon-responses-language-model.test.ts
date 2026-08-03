import { generateText, streamText } from "ai";
import { describe, expect, it } from "vitest";
import {
	RESPONSES_OK,
	startTestGateway,
	type TestGateway,
} from "./neon-test-gateway.js";
import { createNeon } from "./provider.js";

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
		if (request === undefined) {
			throw new Error("the gateway received no request");
		}
		return request;
	} finally {
		await gateway.close();
	}
}

const model = (gateway: TestGateway) =>
	createNeon({ baseURL: gateway.baseURL, apiKey: "test-token" })("gpt-5-2");

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

	it("posts to the Responses path", async () => {
		const gateway = await startTestGateway({ body: RESPONSES_OK });
		try {
			await generateText({ model: model(gateway), prompt: "hi" });
		} finally {
			await gateway.close();
		}
		expect(gateway.requests).toHaveLength(1);
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
			).rejects.toThrow(/must be `false` or omitted/);

			expect(gateway.requests).toHaveLength(0);
		} finally {
			await gateway.close();
		}
	});
});
