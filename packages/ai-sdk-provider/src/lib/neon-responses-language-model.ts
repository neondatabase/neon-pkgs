import { OpenAIResponsesLanguageModel } from "@ai-sdk/openai/internal";
import type {
	LanguageModelV3,
	LanguageModelV3CallOptions,
	LanguageModelV3GenerateResult,
	LanguageModelV3StreamResult,
} from "@ai-sdk/provider";
import { withResponsesGatewayDefaults } from "./neon-responses-options.js";

/**
 * Language model for OpenAI models served via the Neon AI Gateway's native
 * Responses API (`/openai/v1/responses`). This route is required for models
 * that are only served natively (e.g. Codex) and unlocks native reasoning and
 * the image-generation tool.
 *
 * The request shaping lives in `neon-responses-options.ts`, which documents
 * what this route requires and why.
 */
export class NeonResponsesLanguageModel
	extends OpenAIResponsesLanguageModel
	implements LanguageModelV3
{
	override doGenerate(
		options: LanguageModelV3CallOptions,
	): Promise<LanguageModelV3GenerateResult> {
		return super.doGenerate(
			withResponsesGatewayDefaults(this.modelId, options),
		);
	}

	override doStream(
		options: LanguageModelV3CallOptions,
	): Promise<LanguageModelV3StreamResult> {
		return super.doStream(
			withResponsesGatewayDefaults(this.modelId, options),
		);
	}
}
