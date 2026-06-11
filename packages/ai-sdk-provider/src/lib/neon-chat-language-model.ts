import { OpenAICompatibleChatLanguageModel } from "@ai-sdk/openai-compatible";
import type {
	LanguageModelV4,
	LanguageModelV4CallOptions,
	LanguageModelV4GenerateResult,
	LanguageModelV4StreamResult,
} from "@ai-sdk/provider";
import {
	applyNeonCapabilities,
	mergeStreamStartWarnings,
} from "./neon-capabilities.js";

/**
 * Language model for the Neon AI Gateway unified (MLflow) endpoint.
 *
 * Used for every model that is not routed to a provider-native endpoint
 * (Gemini, Llama, Qwen, gpt-oss, ...). It is a thin specialization of the shared
 * OpenAI-compatible chat model that adds per-model capability handling:
 * parameters an upstream backend is known to reject are dropped and reported as
 * warnings instead of failing the request.
 */
export class NeonChatLanguageModel
	extends OpenAICompatibleChatLanguageModel
	implements LanguageModelV4
{
	override async doGenerate(
		options: LanguageModelV4CallOptions,
	): Promise<LanguageModelV4GenerateResult> {
		const { options: adjusted, warnings } = applyNeonCapabilities(
			this.modelId,
			options,
		);
		const result = await super.doGenerate(adjusted);
		return warnings.length > 0
			? { ...result, warnings: [...warnings, ...result.warnings] }
			: result;
	}

	override async doStream(
		options: LanguageModelV4CallOptions,
	): Promise<LanguageModelV4StreamResult> {
		const { options: adjusted, warnings } = applyNeonCapabilities(
			this.modelId,
			options,
		);
		const result = await super.doStream(adjusted);
		return warnings.length > 0
			? {
					...result,
					stream: result.stream.pipeThrough(
						mergeStreamStartWarnings(warnings),
					),
				}
			: result;
	}
}
