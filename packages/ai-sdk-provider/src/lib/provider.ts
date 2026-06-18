/**
 * Community Vercel AI SDK provider for the Neon AI Gateway.
 *
 * `createNeon()` returns a provider that routes each model to the best gateway
 * endpoint based on its id (Anthropic → native Messages, OpenAI → native
 * Responses incl. Codex, everything else → unified MLflow), so a single
 * `neon('claude-...')` call (same base URL + token) reaches the whole catalog.
 * Ids use the canonical Neon (unprefixed) form; the legacy `databricks-` prefix
 * is also accepted. Configure with the branch-scoped `NEON_AI_GATEWAY_BASE_URL` +
 * `NEON_AI_GATEWAY_TOKEN` emitted by `neonctl env pull` / `neon dev`, or pass
 * `baseURL` / `apiKey` explicitly.
 */
import { openai as openaiProvider } from "@ai-sdk/openai";
import type { ProviderErrorStructure } from "@ai-sdk/openai-compatible";
import {
	type LanguageModelV3,
	NoSuchModelError,
	type ProviderV3,
} from "@ai-sdk/provider";
import {
	type FetchFunction,
	generateId,
	loadApiKey,
	loadSetting,
	withoutTrailingSlash,
	withUserAgentSuffix,
} from "@ai-sdk/provider-utils";
import { z } from "zod/v4";
import { NeonAnthropicLanguageModel } from "./neon-anthropic-language-model.js";
import { NeonChatLanguageModel } from "./neon-chat-language-model.js";
import type { NeonChatModelId } from "./neon-chat-options.js";
import { getNeonModelRoute } from "./neon-model-capabilities.js";
import { NeonResponsesLanguageModel } from "./neon-responses-language-model.js";
import { VERSION } from "./version.js";

const neonErrorSchema = z.object({
	error: z.object({
		message: z.string(),
		type: z.string().nullish(),
		param: z.unknown().nullish(),
		code: z.unknown().nullish(),
	}),
});

export type NeonErrorData = z.infer<typeof neonErrorSchema>;

const neonErrorStructure: ProviderErrorStructure<NeonErrorData> = {
	errorSchema: neonErrorSchema,
	errorToMessage: (data) => data.error.message,
};

/**
 * Recursively remove the JSON Schema `$schema` marker, which some gateway
 * backends (notably Gemini) reject in tool/structured-output schemas. Other
 * backends ignore its absence, so stripping it everywhere is safe.
 */
function stripJsonSchemaMarker(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(stripJsonSchemaMarker);
	}
	if (value !== null && typeof value === "object") {
		const result: Record<string, unknown> = {};
		for (const [key, entry] of Object.entries(value)) {
			if (key === "$schema") {
				continue;
			}
			result[key] = stripJsonSchemaMarker(entry);
		}
		return result;
	}
	return value;
}

function transformNeonRequestBody(
	args: Record<string, unknown>,
): Record<string, unknown> {
	const transformed = { ...args };
	if (transformed.tools != null) {
		transformed.tools = stripJsonSchemaMarker(transformed.tools);
	}
	if (transformed.response_format != null) {
		transformed.response_format = stripJsonSchemaMarker(
			transformed.response_format,
		);
	}
	return transformed;
}

export interface NeonProviderSettings {
	/**
	 * Neon AI Gateway base URL — the branch-scoped host root, e.g.
	 * `https://<branch-id>-api.ai.<region>.aws.neon.tech`. The gateway paths are
	 * appended internally. Falls back to the `NEON_AI_GATEWAY_BASE_URL` env var.
	 */
	baseURL?: string;

	/**
	 * Neon AI Gateway platform token (the `nt_live_...` value). Falls back to the
	 * `NEON_AI_GATEWAY_TOKEN` env var.
	 */
	apiKey?: string;

	/** Custom headers to include in the requests. */
	headers?: Record<string, string>;

	/** Custom fetch implementation (e.g. for testing or middleware). */
	fetch?: FetchFunction;
}

export interface NeonProvider extends ProviderV3 {
	/** Creates a Neon AI Gateway model for text generation. */
	(modelId: NeonChatModelId): LanguageModelV3;

	/** Creates a Neon AI Gateway model for text generation. */
	languageModel(modelId: NeonChatModelId): LanguageModelV3;

	/** Creates a Neon AI Gateway chat model for text generation. */
	chat(modelId: NeonChatModelId): LanguageModelV3;

	/** OpenAI Responses tools (e.g. `imageGeneration`) for OpenAI-routed models. */
	tools: typeof openaiProvider.tools;

	/** @deprecated Use `embeddingModel` instead. */
	textEmbeddingModel(modelId: string): never;
}

export function createNeon(options: NeonProviderSettings = {}): NeonProvider {
	// Resolved lazily so that `createNeon()` and the default `neon` instance do
	// not throw at import time when configuration comes from the environment.
	const getHost = () =>
		withoutTrailingSlash(
			loadSetting({
				settingValue: options.baseURL,
				environmentVariableName: "NEON_AI_GATEWAY_BASE_URL",
				settingName: "baseURL",
				description: "Neon AI Gateway base URL",
			}),
		);

	const getHeaders = (extra?: Record<string, string>) =>
		withUserAgentSuffix(
			{
				Authorization: `Bearer ${loadApiKey({
					apiKey: options.apiKey,
					environmentVariableName: "NEON_AI_GATEWAY_TOKEN",
					description: "Neon AI Gateway token",
				})}`,
				...extra,
				...options.headers,
			},
			`neondatabase/ai-sdk-provider/${VERSION}`,
		);

	// Anthropic models -> native Messages API.
	const createAnthropicModel = (modelId: NeonChatModelId) =>
		new NeonAnthropicLanguageModel(modelId, {
			provider: "neon.anthropic",
			baseURL: `${getHost()}/ai-gateway/anthropic/v1`,
			headers: () => getHeaders({ "anthropic-version": "2023-06-01" }),
			fetch: options.fetch,
			generateId,
		});

	// OpenAI models (incl. Codex, only served natively) -> Responses API.
	const createOpenAIModel = (modelId: NeonChatModelId) =>
		new NeonResponsesLanguageModel(modelId, {
			provider: "neon.openai.responses",
			url: ({ path }) => `${getHost()}/ai-gateway/openai/v1${path}`,
			headers: getHeaders,
			fetch: options.fetch,
			fileIdPrefixes: ["file-"],
		});

	// Everything else (Gemini, Llama, Qwen, gpt-oss, ...) -> unified MLflow
	// endpoint. Gemini is here because its native endpoint can't stream.
	const createChatModel = (modelId: NeonChatModelId) =>
		new NeonChatLanguageModel(modelId, {
			provider: "neon.chat",
			url: ({ path }) => `${getHost()}/ai-gateway/mlflow/v1${path}`,
			headers: getHeaders,
			fetch: options.fetch,
			errorStructure: neonErrorStructure,
			transformRequestBody: transformNeonRequestBody,
			supportsStructuredOutputs: true,
		});

	const createLanguageModel = (modelId: NeonChatModelId): LanguageModelV3 => {
		switch (getNeonModelRoute(modelId)) {
			case "anthropic":
				return createAnthropicModel(modelId);
			case "openai":
				return createOpenAIModel(modelId);
			default:
				return createChatModel(modelId);
		}
	};

	const provider = (modelId: NeonChatModelId) => createLanguageModel(modelId);

	provider.specificationVersion = "v3" as const;
	provider.languageModel = createLanguageModel;
	provider.chat = createLanguageModel;
	provider.tools = openaiProvider.tools;

	provider.embeddingModel = (modelId: string) => {
		throw new NoSuchModelError({ modelId, modelType: "embeddingModel" });
	};
	provider.textEmbeddingModel = provider.embeddingModel;
	provider.imageModel = (modelId: string) => {
		throw new NoSuchModelError({ modelId, modelType: "imageModel" });
	};

	return provider;
}

/** Default Neon provider instance (reads `NEON_AI_GATEWAY_*` env vars). */
export const neon = createNeon();
