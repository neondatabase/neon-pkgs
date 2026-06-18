import {
	generateObject,
	generateText,
	stepCountIs,
	streamText,
	tool,
} from "ai";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { neon } from "../src/v1.js";
import {
	assertGatewayEnv,
	expectNoHardFailureWarnings,
	hasGatewayEnv,
	MATRIX_MODELS,
	type MatrixFamily,
	maxTokensFor,
	REASONING_FAMILIES,
} from "./helpers.js";

const PROMPT = "Reply with exactly three words.";
const SYSTEM = "You are a terse assistant. Never use more than three words.";

const summarySchema = z.object({
	topic: z.string(),
	wordCount: z.number(),
});

const weatherTool = tool({
	description: "Return the current temperature for a city in Fahrenheit.",
	inputSchema: z.object({ city: z.string() }),
	execute: async ({ city }) => ({ city, tempF: 72 }),
});

/** Families where structured output is expected to work end-to-end. */
const STRUCTURED_FAMILIES = new Set<MatrixFamily>([
	"anthropic",
	"openai",
	"google",
	"meta",
]);

/** Families where multi-step tool calling is exercised (OpenAI Responses multi-turn tools can 502 on the gateway). */
const TOOL_FAMILIES = new Set<MatrixFamily>(["anthropic", "google", "meta"]);

function modelOptions(family: MatrixFamily) {
	const maxOutputTokens = maxTokensFor(family);
	if (!REASONING_FAMILIES.has(family)) {
		return { maxOutputTokens };
	}
	return {
		maxOutputTokens,
		providerOptions: {
			openai: { reasoningEffort: "low" as const },
		},
	};
}

describe.skipIf(!hasGatewayEnv())(
	"e2e — Neon AI Gateway capability matrix",
	() => {
		assertGatewayEnv();

		describe.each(
			Object.entries(MATRIX_MODELS) as Array<[MatrixFamily, string]>,
		)("%s (%s)", (family, modelId) => {
			it("generateText", async () => {
				const result = await generateText({
					model: neon(modelId),
					prompt: PROMPT,
					...modelOptions(family),
				});
				expect(result.text.trim().length).toBeGreaterThan(0);
				expectNoHardFailureWarnings(result.warnings);
			});

			it("generateText with system prompt", async () => {
				const result = await generateText({
					model: neon(modelId),
					system: SYSTEM,
					prompt: "Say hello.",
					...modelOptions(family),
				});
				expect(result.text.trim().length).toBeGreaterThan(0);
				expectNoHardFailureWarnings(result.warnings);
			});

			it("streamText", async () => {
				const result = streamText({
					model: neon(modelId),
					prompt: PROMPT,
					...modelOptions(family),
				});
				let text = "";
				for await (const part of result.textStream) {
					text += part;
				}
				expect(text.trim().length).toBeGreaterThan(0);
			});

			it.skipIf(!STRUCTURED_FAMILIES.has(family))(
				"generateObject",
				async () => {
					const result = await generateObject({
						model: neon(modelId),
						schema: summarySchema,
						prompt: 'Summarize "serverless postgres" in the schema.',
						...modelOptions(family),
					});
					expect(result.object.topic.length).toBeGreaterThan(0);
					expect(result.object.wordCount).toBeGreaterThan(0);
					expectNoHardFailureWarnings(result.warnings);
				},
			);

			it.skipIf(!TOOL_FAMILIES.has(family))(
				"tool calling (generateText + stepCountIs)",
				async () => {
					const result = await generateText({
						model: neon(modelId),
						prompt: "What is the temperature in Paris? Use the weather tool.",
						tools: { weather: weatherTool },
						stopWhen: stepCountIs(5),
						...modelOptions(family),
					});
					expect(result.text.trim().length).toBeGreaterThan(0);
					expect(result.steps.length).toBeGreaterThanOrEqual(1);
				},
			);
		});

		describe("OpenAI Responses — imageGeneration tool", () => {
			it("streamText with neon.tools.imageGeneration returns JPEG", async () => {
				const result = streamText({
					model: neon(MATRIX_MODELS.openai),
					prompt: "Generate a simple red circle on a white background.",
					tools: {
						image_generation: neon.tools.imageGeneration({
							outputFormat: "jpeg",
							quality: "low",
							outputCompression: 30,
							size: "1024x1024",
						}),
					},
					...modelOptions("openai"),
				});

				let gotImage = false;
				for await (const part of result.fullStream) {
					if (
						part.type === "tool-result" &&
						part.toolName === "image_generation" &&
						typeof part.output === "object" &&
						part.output !== null &&
						"result" in part.output &&
						typeof part.output.result === "string" &&
						part.output.result.length > 1000
					) {
						gotImage = true;
					}
				}
				expect(gotImage).toBe(true);
			}, 120_000);
		});

		describe("known gateway limitations", () => {
			it.skip("gpt-oss harmony response shape is not OpenAI-compatible on MLflow", () => {
				// Documented limitation — see README.
			});

			it.skip("OpenAI Responses multi-turn tool follow-up can 502 on the gateway", () => {
				// gpt-5-mini tool calling works for the first step but follow-up requests can 502.
			});
		});
	},
);
