import { OpenAIResponsesLanguageModel } from "@ai-sdk/openai/internal";
import type {
	LanguageModelV3,
	LanguageModelV3CallOptions,
	LanguageModelV3GenerateResult,
	LanguageModelV3StreamResult,
} from "@ai-sdk/provider";

/**
 * Language model for OpenAI models served via the Neon AI Gateway's native
 * Responses API (`/openai/v1/responses`). This route is required for
 * models that are only served natively (e.g. Codex) and unlocks native
 * reasoning and the image-generation tool.
 *
 * Two defaults are applied here, both overridable by an explicit user setting.
 *
 * `store: false`, for every model on this route. The gateway serves the
 * Responses API statelessly and keeps no items — a response comes back with
 * `"store": false` even when the request never set it. The shared model
 * otherwise assumes OpenAI's stored-item semantics and replays earlier
 * reasoning as `{ type: "item_reference", id }`, which nothing upstream can
 * resolve; the gateway answers `502 INTERNAL_ERROR`. It surfaces on the second
 * step of a tool loop, after the first has already succeeded. Setting the flag
 * makes the model inline the encrypted reasoning instead, which is the only
 * shape this gateway can serve.
 *
 * `forceReasoning: true`, for the GPT-5 family. The shared model shapes a
 * request based on whether the model is a reasoning model, but its detection is
 * brittle here: the gateway also accepts the legacy `databricks-` prefix, which
 * defeats the upstream bare-id (`gpt-5`) match.
 */
export class NeonResponsesLanguageModel
	extends OpenAIResponsesLanguageModel
	implements LanguageModelV3
{
	private get isReasoningFamily(): boolean {
		return /gpt-5/.test(this.modelId.toLowerCase());
	}

	private withGatewayDefaults(
		options: LanguageModelV3CallOptions,
	): LanguageModelV3CallOptions {
		const openai = options.providerOptions?.openai;
		const defaults: Record<string, boolean> = {};
		if (openai == null || !("store" in openai)) {
			defaults.store = false;
		}
		if (
			this.isReasoningFamily &&
			(openai == null || !("forceReasoning" in openai))
		) {
			defaults.forceReasoning = true;
		}
		if (Object.keys(defaults).length === 0) {
			return options;
		}
		return {
			...options,
			providerOptions: {
				...options.providerOptions,
				openai: { ...openai, ...defaults },
			},
		};
	}

	override doGenerate(
		options: LanguageModelV3CallOptions,
	): Promise<LanguageModelV3GenerateResult> {
		return super.doGenerate(this.withGatewayDefaults(options));
	}

	override doStream(
		options: LanguageModelV3CallOptions,
	): Promise<LanguageModelV3StreamResult> {
		return super.doStream(this.withGatewayDefaults(options));
	}
}
