import { AnthropicMessagesLanguageModel } from "@ai-sdk/anthropic/internal";
import type {
	LanguageModelV3,
	LanguageModelV3CallOptions,
	LanguageModelV3GenerateResult,
	LanguageModelV3StreamResult,
} from "@ai-sdk/provider";

/**
 * Language model for Anthropic models served via the Neon AI Gateway's native
 * Messages API (`/anthropic/v1/messages`). Unlocks streaming
 * structured output and native reasoning for Claude.
 *
 * The shared Anthropic model defaults to fine-grained tool-input streaming
 * (`eager_input_streaming: true`) on streaming tool calls, which the gateway
 * rejects (`Extra inputs are not permitted`). We disable it via the model's own
 * `toolStreaming` option so streaming tool calls work. Users can still override.
 */
export class NeonAnthropicLanguageModel
	extends AnthropicMessagesLanguageModel
	implements LanguageModelV3
{
	private withGatewayCompat(
		options: LanguageModelV3CallOptions,
	): LanguageModelV3CallOptions {
		const anthropic = options.providerOptions?.anthropic;
		// Respect an explicit user setting.
		if (anthropic != null && "toolStreaming" in anthropic) {
			return options;
		}
		return {
			...options,
			providerOptions: {
				...options.providerOptions,
				anthropic: { ...anthropic, toolStreaming: false },
			},
		};
	}

	override doGenerate(
		options: LanguageModelV3CallOptions,
	): Promise<LanguageModelV3GenerateResult> {
		return super.doGenerate(this.withGatewayCompat(options));
	}

	override doStream(
		options: LanguageModelV3CallOptions,
	): Promise<LanguageModelV3StreamResult> {
		return super.doStream(this.withGatewayCompat(options));
	}
}
