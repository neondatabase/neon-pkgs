import { generateText as generateTextV6 } from "ai";
import {
	generateText as generateTextV7,
	streamText as streamTextV7,
} from "ai-v7";
import { beforeAll, describe, expect, it } from "vitest";
import { neon } from "../src/index.js";
import { assertGatewayEnv, withRateLimitRetry } from "./helpers.js";

const PROMPT = "Reply with exactly the single word pong.";
const CONCURRENCY = 4;

interface SdkRunner {
	version: string;
	generate(modelId: string): Promise<string>;
}

const SDK_RUNNERS = [
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
	},
] satisfies SdkRunner[];

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function fetchCurrentModelIds(): Promise<string[]> {
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

	const ids = payload.data.flatMap((model) =>
		isRecord(model) && typeof model.id === "string" ? [model.id] : [],
	);
	if (ids.length === 0) {
		throw new Error(
			"The gateway /v1/models endpoint returned no model ids",
		);
	}
	return [...new Set(ids)].sort();
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

describe("e2e — every currently enabled model on AI SDK 6 and 7", () => {
	let modelIds: string[] = [];

	beforeAll(async () => {
		modelIds = await fetchCurrentModelIds();
	});

	for (const runner of SDK_RUNNERS) {
		it(`generates text with every /v1/models entry using AI SDK ${runner.version}`, async () => {
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
