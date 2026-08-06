import { AnthropicMessagesLanguageModel } from "@ai-sdk/anthropic/internal";
import type {
	LanguageModelV3,
	LanguageModelV3CallOptions,
	LanguageModelV3GenerateResult,
	LanguageModelV3StreamResult,
	SharedV3Warning,
} from "@ai-sdk/provider";
import {
	applyNeonCapabilities,
	mergeStreamStartWarnings,
} from "./neon-capabilities.js";

/**
 * Language model for Anthropic models served via the Neon AI Gateway's native
 * Messages API (`/anthropic/v1/messages`). Unlocks streaming
 * structured output and native reasoning for Claude.
 *
 * The shared Anthropic model defaults to fine-grained tool-input streaming
 * (`eager_input_streaming: true`) on streaming tool calls, which the gateway
 * rejects (`Extra inputs are not permitted`). We disable it via the model's own
 * `toolStreaming` option so streaming tool calls work. Users can still override.
 *
 * Capability filtering runs here as well as on the unified endpoint. The
 * upstream Anthropic model drops sampling parameters for the Claude versions it
 * knows about, but not for ones released after it, so `claude-opus-5` and
 * `claude-sonnet-5` reached the API and came back
 * `` `temperature` is deprecated for this model ``. Applying our own rules keeps
 * the behaviour tied to what the gateway was measured to accept rather than to
 * the SDK's release date.
 */
export class NeonAnthropicLanguageModel
	extends AnthropicMessagesLanguageModel
	implements LanguageModelV3
{
	private withGatewayCompat(options: LanguageModelV3CallOptions): {
		options: LanguageModelV3CallOptions;
		warnings: SharedV3Warning[];
	} {
		const { options: adjusted, warnings } = applyNeonCapabilities(
			this.modelId,
			options,
		);
		const anthropic = adjusted.providerOptions?.anthropic;
		// Respect an explicit user setting.
		if (anthropic != null && "toolStreaming" in anthropic) {
			return { options: adjusted, warnings };
		}
		return {
			options: {
				...adjusted,
				providerOptions: {
					...adjusted.providerOptions,
					anthropic: { ...anthropic, toolStreaming: false },
				},
			},
			warnings,
		};
	}

	override async doGenerate(
		options: LanguageModelV3CallOptions,
	): Promise<LanguageModelV3GenerateResult> {
		const { options: adjusted, warnings } = this.withGatewayCompat(options);
		const result = await super.doGenerate(adjusted);
		return warnings.length > 0
			? { ...result, warnings: [...warnings, ...result.warnings] }
			: result;
	}

	override async doStream(
		options: LanguageModelV3CallOptions,
	): Promise<LanguageModelV3StreamResult> {
		const { options: adjusted, warnings } = this.withGatewayCompat(options);
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
