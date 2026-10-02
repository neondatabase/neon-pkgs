import type { EmbeddingModelV3 } from "@ai-sdk/provider";
import {
	embedMany as embedManyV6,
	embed as embedV6,
	generateText as generateTextV6,
} from "ai";
import {
	embedMany as embedManyV7,
	embed as embedV7,
	generateText as generateTextV7,
	streamText as streamTextV7,
} from "ai-v7";
import { beforeAll, describe, expect, it } from "vitest";
import { createNeon, NEON_EMBEDDING_MODEL_IDS, neon } from "../src/index.js";
import { assertGatewayEnv, withRateLimitRetry } from "./helpers.js";

const PROMPT = "Reply with exactly the single word pong.";
const CONCURRENCY = 4;

type EmbeddingProviderOptions = { neon: { dimensions: number } };

interface SdkRunner {
	version: string;
	generate(modelId: string): Promise<string>;
	embed(
		model: EmbeddingModelV3,
		value: string,
		providerOptions?: EmbeddingProviderOptions,
	): Promise<number[]>;
	embedMany(model: EmbeddingModelV3, values: string[]): Promise<number[][]>;
}

const SDK_RUNNERS: readonly [SdkRunner, SdkRunner] = [
	{
		version: "6",
		async generate(modelId) {
			const result = await withRateLimitRetry(() =>
				generateTextV6({
					model: neon(modelId),
					prompt: PROMPT,
					maxOutputTokens: 2048,
				}),
			);
			return result.text;
		},
		async embed(model, value, providerOptions) {
			const result = await withRateLimitRetry(() =>
				embedV6({ model, value, providerOptions }),
			);
			return result.embedding;
		},
		async embedMany(model, values) {
			const result = await withRateLimitRetry(() =>
				embedManyV6({ model, values }),
			);
			return result.embeddings;
		},
	},
	{
		version: "7",
		async generate(modelId) {
			const result = await withRateLimitRetry(() =>
				generateTextV7({
					model: neon(modelId),
					prompt: PROMPT,
					maxOutputTokens: 2048,
				}),
			);
			return result.text;
		},
		async embed(model, value, providerOptions) {
			const result = await withRateLimitRetry(() =>
				embedV7({ model, value, providerOptions }),
			);
			return result.embedding;
		},
		async embedMany(model, values) {
			const result = await withRateLimitRetry(() =>
				embedManyV7({ model, values }),
			);
			return result.embeddings;
		},
	},
];

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

interface CurrentModels {
	chat: string[];
	embedding: string[];
}

/** Chat models report `["text"]` here, embedding models `["embeddings"]`. */
function outputModalities(model: Record<string, unknown>): unknown[] {
	const outputs = isRecord(model.architecture)
		? model.architecture.output_modalities
		: undefined;
	if (!Array.isArray(outputs)) {
		throw new Error(
			`Unexpected /v1/models entry ${String(model.id)}: missing architecture.output_modalities`,
		);
	}
	return outputs;
}

async function fetchCurrentModels(): Promise<CurrentModels> {
	assertGatewayEnv();
	const baseURL = process.env.NEON_AI_GATEWAY_BASE_URL;
	const token = process.env.NEON_AI_GATEWAY_TOKEN;
	if (baseURL === undefined || token === undefined) {
		throw new Error("Gateway environment was not initialized");
	}

	const response = await fetch(`${baseURL.replace(/\/$/, "")}/v1/models`, {
		headers: {
			Authorization: `Bearer ${token}`,
			Accept: "application/json",
		},
	});
	if (!response.ok) {
		throw new Error(
			`Failed to list current gateway models: ${response.status} ${response.statusText}`,
		);
	}

	const payload: unknown = await response.json();
	if (!isRecord(payload) || !Array.isArray(payload.data)) {
		throw new Error("Unexpected /v1/models response: missing data array");
	}

	const chat = new Set<string>();
	const embedding = new Set<string>();
	for (const model of payload.data) {
		if (!isRecord(model) || typeof model.id !== "string") continue;
		const outputs = outputModalities(model);
		if (outputs.includes("text")) chat.add(model.id);
		if (outputs.includes("embeddings")) embedding.add(model.id);
	}
	if (chat.size === 0 || embedding.size === 0) {
		throw new Error(
			`The gateway /v1/models endpoint returned ${chat.size} text and ${embedding.size} embedding models`,
		);
	}
	return { chat: [...chat].sort(), embedding: [...embedding].sort() };
}

function expectVector(vector: number[], dimensions: number) {
	expect(vector).toHaveLength(dimensions);
	expect(vector.every((value) => Number.isFinite(value))).toBe(true);
}

async function verifyAllModels(
	modelIds: string[],
	runner: SdkRunner,
): Promise<string[]> {
	const failures: string[] = [];

	for (let index = 0; index < modelIds.length; index += CONCURRENCY) {
		const batch = modelIds.slice(index, index + CONCURRENCY);
		const results = await Promise.all(
			batch.map(async (modelId) => {
				try {
					const text = await runner.generate(modelId);
					if (text.trim().length === 0) {
						return `${modelId}: generated an empty response`;
					}
					return null;
				} catch (error) {
					const message =
						error instanceof Error ? error.message : String(error);
					return `${modelId}: ${message}`;
				}
			}),
		);

		for (const result of results) {
			if (result !== null) failures.push(result);
		}
	}

	return failures;
}

describe("e2e — every currently enabled chat model on AI SDK 6 and 7", () => {
	let modelIds: string[] = [];

	beforeAll(async () => {
		modelIds = (await fetchCurrentModels()).chat;
	});

	for (const runner of SDK_RUNNERS) {
		it(`generates text with every text-output /v1/models entry using AI SDK ${runner.version}`, async () => {
			const failures = await verifyAllModels(modelIds, runner);
			expect(
				failures,
				`AI SDK ${runner.version} failures:\n${failures.join("\n")}`,
			).toEqual([]);
		}, 600_000);
	}

	it("uses the Neon image-generation tool with AI SDK 7", async () => {
		const gotImage = await withRateLimitRetry(async () => {
			const result = streamTextV7({
				model: neon("gpt-5-mini"),
				prompt: "Generate a simple red circle on a white background.",
				tools: {
					image_generation: neon.tools.imageGeneration({
						outputFormat: "jpeg",
						quality: "low",
						outputCompression: 30,
						size: "1024x1024",
					}),
				},
				maxOutputTokens: 2048,
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

describe("e2e — every currently enabled embedding model on AI SDK 6 and 7", () => {
	let modelIds: string[] = [];

	beforeAll(async () => {
		modelIds = (await fetchCurrentModels()).embedding;
	});

	it("serves every embedding model the provider lists", () => {
		const missing = NEON_EMBEDDING_MODEL_IDS.filter(
			(id) => !modelIds.includes(id),
		);
		expect(missing, `not served: ${missing.join(", ")}`).toEqual([]);
	});

	for (const runner of SDK_RUNNERS) {
		it(`embeds with every embedding /v1/models entry using AI SDK ${runner.version}`, async () => {
			for (const modelId of modelIds) {
				const model = neon.embeddingModel(modelId);
				const single = await runner.embed(
					model,
					"Neon branches are copy-on-write.",
				);
				const many = await runner.embedMany(model, [
					"Neon branches are copy-on-write.",
					"Scale to zero suspends idle computes.",
				]);
				const known: readonly string[] = NEON_EMBEDDING_MODEL_IDS;
				const dimensions = known.includes(modelId)
					? 1024
					: single.length;
				expect(dimensions, modelId).toBeGreaterThan(0);
				expectVector(single, dimensions);
				expect(many, modelId).toHaveLength(2);
				for (const vector of many) expectVector(vector, dimensions);
			}
		}, 120_000);

		it(`splits embedMany over the 150-input gateway limit using AI SDK ${runner.version}`, async () => {
			const batchSizes: number[] = [];
			const recording = createNeon({
				fetch: async (input, init) => {
					if (typeof init?.body === "string") {
						const body: unknown = JSON.parse(init.body);
						if (isRecord(body) && Array.isArray(body.input)) {
							batchSizes.push(body.input.length);
						}
					}
					return fetch(input, init);
				},
			});
			const values = Array.from(
				{ length: 151 },
				(_, i) => `document ${i}`,
			);
			const embeddings = await runner.embedMany(
				recording.embeddingModel("qwen3-embedding-0-6b"),
				values,
			);
			expect(batchSizes.sort((a, b) => b - a)).toEqual([150, 1]);
			expect(embeddings).toHaveLength(151);
			for (const vector of embeddings) expectVector(vector, 1024);
			const [last] = await runner.embedMany(
				neon.embeddingModel("qwen3-embedding-0-6b"),
				["document 150"],
			);
			expect(embeddings[150]?.slice(0, 8)).toEqual(last?.slice(0, 8));
		}, 120_000);
	}

	it("passes dimensions through providerOptions.neon", async () => {
		const [runner] = SDK_RUNNERS;
		const options = { neon: { dimensions: 256 } };
		expectVector(
			await runner.embed(
				neon.embeddingModel("qwen3-embedding-0-6b"),
				"branching",
				options,
			),
			256,
		);
		expectVector(
			await runner.embed(
				neon.embeddingModel("gte-large-en"),
				"branching",
				options,
			),
			1024,
		);
	}, 60_000);

	it("surfaces the gateway's reason for an unknown embedding model", async () => {
		const [runner] = SDK_RUNNERS;
		await expect(
			runner.embed(neon.embeddingModel("nope-embedding"), "branching"),
		).rejects.toThrow(/unknown model/);
	}, 60_000);
});
