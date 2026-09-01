import {
	generateObject,
	generateText,
	stepCountIs,
	streamText,
	tool,
} from "ai";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { neon } from "../src/index.js";
import {
	assertGatewayEnv,
	expectNoHardFailureWarnings,
	fetchServedModelIds,
	MATRIX_MODELS,
	type MatrixFamily,
	maxTokensFor,
	REASONING_EFFORT_FAMILIES,
	withRateLimitRetry,
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

/**
 * Families where structured output is expected to work end-to-end.
 *
 * Gemini is excluded: on the unified endpoint it answers `generateObject` with
 * prose the SDK cannot parse into the schema ("No object generated"), measured
 * on both `gemini-3-flash` and `gemini-3-5-flash`.
 */
const STRUCTURED_FAMILIES = new Set<MatrixFamily>([
	"anthropic",
	"openai",
	"codex",
	"meta",
	"alibaba",
]);

/**
 * Families where multi-step tool calling is exercised.
 *
 * OpenAI and Codex matter most here: their Responses tool loop is the one that
 * breaks if the SDK ever replays reasoning as an `item_reference` the stateless
 * gateway cannot resolve, which the gateway answers with a 502.
 *
 * Gemini is excluded: the tool round trip 400s on the replay leg, since the AI
 * SDK does not echo back the `thoughtSignature` Gemini expects.
 */
const TOOL_FAMILIES = new Set<MatrixFamily>([
	"anthropic",
	"openai",
	"codex",
	"meta",
	"alibaba",
]);

function modelOptions(family: MatrixFamily) {
	const maxOutputTokens = maxTokensFor(family);
	if (!REASONING_EFFORT_FAMILIES.has(family)) {
		return { maxOutputTokens };
	}
	return {
		maxOutputTokens,
		providerOptions: {
			openai: { reasoningEffort: "low" as const },
		},
	};
}

assertGatewayEnv();

const served = await fetchServedModelIds();

describe("e2e — Neon AI Gateway capability matrix", () => {
	it("serves every model the matrix pins", () => {
		const missing = Object.entries(MATRIX_MODELS)
			.filter(([, modelId]) => !served.has(modelId))
			.map(([family, modelId]) => `${family} (${modelId})`);
		expect(
			missing,
			`The gateway no longer serves ${missing.length} of the ${
				Object.keys(MATRIX_MODELS).length
			} pinned models, so those families' cases below skipped and proved nothing. ` +
				"Pick a replacement id per family in e2e/helpers.ts, or restore the account's access.",
		).toEqual([]);
	});

	describe.each(
		Object.entries(MATRIX_MODELS) as Array<[MatrixFamily, string]>,
	)("%s (%s)", (family, modelId) => {
		const servesModel = served.has(modelId);

		it.skipIf(!servesModel)(
			"generateText",
			async () => {
				const result = await withRateLimitRetry(() =>
					generateText({
						model: neon(modelId),
						prompt: PROMPT,
						...modelOptions(family),
					}),
				);
				expect(result.text.trim().length).toBeGreaterThan(0);
				expectNoHardFailureWarnings(result.warnings);
			},
			180_000,
		);

		it.skipIf(!servesModel)(
			"generateText with system prompt",
			async () => {
				const result = await withRateLimitRetry(() =>
					generateText({
						model: neon(modelId),
						system: SYSTEM,
						prompt: "Say hello.",
						...modelOptions(family),
					}),
				);
				expect(result.text.trim().length).toBeGreaterThan(0);
				expectNoHardFailureWarnings(result.warnings);
			},
			180_000,
		);

		it.skipIf(!servesModel)(
			"streamText",
			async () => {
				const text = await withRateLimitRetry(async () => {
					const result = streamText({
						model: neon(modelId),
						prompt: PROMPT,
						...modelOptions(family),
					});
					let collected = "";
					for await (const part of result.textStream) {
						collected += part;
					}
					return collected;
				});
				expect(text.trim().length).toBeGreaterThan(0);
			},
			180_000,
		);

		it.skipIf(!servesModel || !STRUCTURED_FAMILIES.has(family))(
			"generateObject",
			async () => {
				const result = await withRateLimitRetry(() =>
					generateObject({
						model: neon(modelId),
						schema: summarySchema,
						prompt: 'Summarize "serverless postgres" in the schema.',
						...modelOptions(family),
					}),
				);
				expect(result.object.topic.length).toBeGreaterThan(0);
				expect(result.object.wordCount).toBeGreaterThan(0);
				expectNoHardFailureWarnings(result.warnings);
			},
			180_000,
		);

		it.skipIf(!servesModel || !TOOL_FAMILIES.has(family))(
			"tool calling (generateText + stepCountIs)",
			async () => {
				const result = await withRateLimitRetry(() =>
					generateText({
						model: neon(modelId),
						prompt: "What is the temperature in Paris? Use the weather tool.",
						tools: { weather: weatherTool },
						stopWhen: stepCountIs(5),
						...modelOptions(family),
					}),
				);
				expect(result.text.trim().length).toBeGreaterThan(0);
				// A tool call plus a follow-up step, not one step that happened
				// to answer. The follow-up is the leg that carries prior
				// reasoning back to the gateway, so anything less would pass
				// while the multi-turn path is broken.
				expect(
					result.steps.flatMap((step) => step.toolCalls).length,
				).toBeGreaterThanOrEqual(1);
				expect(result.steps.length).toBeGreaterThanOrEqual(2);
			},
			180_000,
		);
	});

	describe("OpenAI Responses — multi-step tool loop over streamText", () => {
		// The stored-item 502 struck the second step of a loop, and
		// `doStream` applies the request defaults on its own path, so the
		// generateText cases above would not catch a regression there.
		it.skipIf(!served.has(MATRIX_MODELS.openai))(
			"gets past the step that carries reasoning back",
			async () => {
				const { steps, text } = await withRateLimitRetry(async () => {
					const result = streamText({
						model: neon(MATRIX_MODELS.openai),
						prompt: "What is the temperature in Paris? Use the weather tool.",
						tools: { weather: weatherTool },
						stopWhen: stepCountIs(5),
						...modelOptions("openai"),
					});
					await result.consumeStream();
					return {
						steps: await result.steps,
						text: await result.text,
					};
				});
				expect(
					steps.flatMap((step) => step.toolCalls).length,
				).toBeGreaterThanOrEqual(1);
				expect(steps.length).toBeGreaterThanOrEqual(2);
				expect(text).not.toBe("");
			},
			180_000,
		);
	});

	describe("OpenAI Responses — imageGeneration tool", () => {
		it("streamText with neon.tools.imageGeneration returns JPEG", async () => {
			const gotImage = await withRateLimitRetry(async () => {
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

				let found = false;
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
						found = true;
					}
				}
				return found;
			});
			expect(gotImage).toBe(true);
		}, 180_000);
	});

	// Every one of these returns 400 if the provider forwards the parameter,
	// so the capability table is the only thing keeping the call alive. A
	// unit test proves the table says the right thing; only a live call
	// proves the table still matches the gateway.
	describe("sampling parameters the gateway rejects per model", () => {
		it.each([
			{
				model: "kimi-k3",
				dropped: ["frequencyPenalty", "presencePenalty"],
			},
			{
				model: "gemini-3-5-flash-lite",
				dropped: ["frequencyPenalty", "presencePenalty"],
			},
			{
				model: "gemini-3-6-flash",
				dropped: [
					"temperature",
					"topP",
					"frequencyPenalty",
					"presencePenalty",
				],
			},
		])("$model answers instead of 400ing, and reports what was dropped", async ({
			model,
			dropped,
		}) => {
			const result = await withRateLimitRetry(() =>
				generateText({
					model: neon(model),
					prompt: "Reply with exactly three words.",
					maxOutputTokens: 512,
					temperature: 0.2,
					topP: 0.9,
					frequencyPenalty: 0.5,
					presencePenalty: 0.5,
				}),
			);

			expect(result.text.trim().length).toBeGreaterThan(0);
			const reported = (result.warnings ?? [])
				.map((w) => ("feature" in w ? w.feature : undefined))
				.filter(Boolean);
			expect(new Set(reported)).toEqual(new Set(dropped));
		}, 180_000);

		// The older Gemini models still take penalties. If this starts
		// failing, the restriction has spread and the id list needs widening
		// rather than the assertion loosening.
		it("still sends penalties to the Gemini models that accept them", async () => {
			const result = await withRateLimitRetry(() =>
				generateText({
					model: neon("gemini-3-flash"),
					prompt: "Reply with exactly three words.",
					maxOutputTokens: 512,
					frequencyPenalty: 0.5,
				}),
			);

			expect(result.text.trim().length).toBeGreaterThan(0);
			expect(result.warnings ?? []).toEqual([]);
		}, 180_000);
	});

	// The provider used to drop reasoningEffort on Gemini and tell the caller
	// the model did not take it. The gateway maps it onto Gemini's thinking
	// config, so that cost people control over spend they were billed for
	// either way. Asserted live because the claim was about the gateway.
	describe("reasoningEffort on Gemini", () => {
		it("changes how much the model reasons", async () => {
			const reason = async (effort: "minimal" | "high") => {
				const result = await withRateLimitRetry(() =>
					generateText({
						model: neon("gemini-3-6-flash"),
						prompt: "A farmer has 17 sheep. All but 9 run away. How many remain? Think it through.",
						maxOutputTokens: 900,
						providerOptions: { neon: { reasoningEffort: effort } },
					}),
				);
				expect(result.warnings ?? []).toEqual([]);
				const usage = (
					result as {
						response?: {
							body?: { usage?: Record<string, number> };
						};
					}
				).response?.body?.usage;
				return usage?.reasoning_tokens ?? 0;
			};

			const [minimal, high] = [
				await reason("minimal"),
				await reason("high"),
			];
			expect(minimal).toBe(0);
			expect(high).toBeGreaterThan(0);
		}, 240_000);
	});

	describe("gpt-oss harmony normalization (#308)", () => {
		// The gateway returns gpt-oss `message.content` as a harmony parts
		// array; the provider normalizes it to the OpenAI Chat Completions
		// contract. Verify text comes through for both generate and stream.
		it("generateText works and does not throw on the harmony shape", async () => {
			const result = await withRateLimitRetry(() =>
				generateText({
					model: neon("gpt-oss-120b"),
					prompt: "Reply with exactly three words.",
					maxOutputTokens: 512,
				}),
			);
			expect(result.text.trim().length).toBeGreaterThan(0);
		}, 180_000);

		it("streamText works without an invalid-JSON error flood", async () => {
			const text = await withRateLimitRetry(async () => {
				const result = streamText({
					model: neon("gpt-oss-120b"),
					prompt: "Reply with exactly three words.",
					maxOutputTokens: 512,
				});
				let collected = "";
				for await (const part of result.textStream) {
					collected += part;
				}
				return collected;
			});
			expect(text.trim().length).toBeGreaterThan(0);
		}, 180_000);
	});
});
