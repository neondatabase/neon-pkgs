import { generateText } from "ai";
import { describe, expect, it } from "vitest";
import { neon } from "../src/index.js";
import { hasGatewayEnv, MATRIX_MODELS } from "./helpers.js";

/**
 * The Responses route answers with three different error envelopes, and only
 * one of them is the OpenAI shape `@ai-sdk/openai` can parse. The other two
 * used to reach the caller as a bare `AI_APICallError: Bad Request`, with the
 * reason stranded on `responseBody`.
 *
 * These assert the reason actually lands in `error.message` against the live
 * gateway. The unit tests in `neon-gateway-error.test.ts` pin the exact
 * envelopes; these prove the wiring and that the gateway still emits them.
 */
const model = MATRIX_MODELS.openai;

async function messageFor(options: Record<string, unknown>): Promise<string> {
	try {
		await generateText({
			model: neon(model),
			prompt: "Reply with exactly three words.",
			...options,
		} as never);
	} catch (error) {
		return (error as { message: string }).message;
	}
	throw new Error("expected the gateway to reject this request");
}

describe.skipIf(!hasGatewayEnv())(
	`e2e — Responses error surfacing (${model})`,
	() => {
		it("surfaces a flat Databricks rejection", async () => {
			// service_tier='flex' is refused by Databricks itself, which answers
			// { error_code, message } with no nested `error`.
			const message = await messageFor({
				providerOptions: { openai: { serviceTier: "flex" } },
			});

			expect(message).not.toBe("Bad Request");
			expect(message).toContain("service_tier");
			expect(message).toContain("not supported by Databricks");
		});

		it("surfaces the inner error when one is wrapped as a JSON string", async () => {
			// Databricks forwards the upstream OpenAI error inside `message` as
			// an encoded envelope; the useful text is two levels down.
			const message = await messageFor({ maxOutputTokens: 1 });

			expect(message).not.toBe("Bad Request");
			expect(message).toContain("max_output_tokens");
			expect(message).toContain("16");
		});

		it("leaves an already OpenAI-shaped error intact", async () => {
			try {
				await generateText({
					model: neon("gpt-5-9-does-not-exist"),
					prompt: "hi",
					maxOutputTokens: 512,
				});
				throw new Error("expected the gateway to reject this request");
			} catch (error) {
				expect((error as { message: string }).message).toContain(
					"unknown model",
				);
			}
		});
	},
);
