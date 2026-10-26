import { UnsupportedFunctionalityError } from "@ai-sdk/provider";
import { streamText } from "ai";
import { describe, expect, it } from "vitest";
import {
	RESPONSES_OK,
	startTestGateway,
	type TestGateway,
} from "../../test/gateway-server.js";
import { createNeon } from "./provider.js";

async function sentToolsFor(
	call: (gateway: TestGateway) => Promise<unknown>,
): Promise<unknown> {
	const gateway = await startTestGateway({ body: RESPONSES_OK });
	try {
		await call(gateway);
		const [request] = gateway.requests;
		if (request?.body === undefined) {
			throw new Error("the gateway received no request body");
		}
		return request.body.tools;
	} finally {
		await gateway.close();
	}
}

const neonFor = (gateway: TestGateway) =>
	createNeon({ baseURL: gateway.baseURL, apiKey: "test-token" });

describe("neon.tools.imageGeneration", () => {
	it("sends gpt-image-2 when no model is given", async () => {
		const tools = await sentToolsFor(async (gateway) => {
			const neon = neonFor(gateway);
			const result = streamText({
				model: neon("gpt-5-mini"),
				prompt: "draw",
				tools: {
					image_generation: neon.tools.imageGeneration({
						outputFormat: "jpeg",
					}),
				},
			});
			await result.consumeStream();
		});

		expect(tools).toEqual([
			expect.objectContaining({
				type: "image_generation",
				model: "gpt-image-2",
				output_format: "jpeg",
			}),
		]);
	});

	it("sends the model it is given", async () => {
		const tools = await sentToolsFor(async (gateway) => {
			const neon = neonFor(gateway);
			const result = streamText({
				model: neon("gpt-5-mini"),
				prompt: "draw",
				tools: {
					image_generation: neon.tools.imageGeneration({
						model: "gpt-image-1-mini",
					}),
				},
			});
			await result.consumeStream();
		});

		expect(tools).toEqual([
			expect.objectContaining({ model: "gpt-image-1-mini" }),
		]);
	});

	it("refuses gpt-image-1", () => {
		const neon = createNeon({
			baseURL: "http://unused",
			apiKey: "test-token",
		});

		const build = () =>
			neon.tools.imageGeneration({ model: "gpt-image-1" });

		expect(build).toThrow(UnsupportedFunctionalityError);
		expect(build).toThrow(/Use `gpt-image-2`/);
	});
});
