import { OpenAIResponsesLanguageModel } from "@ai-sdk/openai/internal";
import {
	type LanguageModelV3,
	type LanguageModelV3CallOptions,
	type LanguageModelV3GenerateResult,
	type LanguageModelV3StreamResult,
	UnsupportedFunctionalityError,
} from "@ai-sdk/provider";

/**
 * Language model for OpenAI models served via the Neon AI Gateway's native
 * Responses API (`/openai/v1/responses`). This route is required for
 * models that are only served natively (e.g. Codex) and unlocks native
 * reasoning and the image-generation tool.
 *
 * Two request defaults are applied here.
 *
 * `store: false`, for every model on this route, and it is the one value this
 * gateway accepts rather than a preference. The gateway serves the Responses
 * API statelessly and keeps no items — a response comes back with
 * `"store": false` even when the request never set it. The shared model
 * otherwise assumes OpenAI's stored-item semantics and replays earlier
 * reasoning as `{ type: "item_reference", id }`, which nothing upstream can
 * resolve; the gateway answers `502 INTERNAL_ERROR` on the second step of a
 * tool loop, after the first has already succeeded. Sending `false` makes the
 * model inline the encrypted reasoning instead.
 *
 * Because no other value can work, an explicit `store` that is not `false` is
 * refused here rather than sent: the request would come back `400
 * INVALID_PARAMETER_VALUE` after a round trip, and quietly forcing it to
 * `false` would be the wrong kind of quiet for a data-retention flag. A
 * type-level constraint is not available — `providerOptions` is
 * `Record<string, JSONObject>`, so a provider cannot narrow it at the call
 * site.
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
		// `undefined` counts as unset rather than as a choice: it serializes
		// away, so `{ store: undefined }` and `{}` are the same request on the
		// wire, and threading an optional config value through must not
		// silently drop the default.
		if (openai?.store === undefined) {
			defaults.store = false;
		} else if (openai.store !== false) {
			throw new UnsupportedFunctionalityError({
				functionality:
					"storing responses (providerOptions.openai.store)",
				message:
					"The Neon AI Gateway serves the Responses API statelessly and does " +
					"not store response items, so `store` must be `false` or omitted. " +
					`Received ${JSON.stringify(openai.store)}. Sending it reaches the ` +
					"gateway as `400 INVALID_PARAMETER_VALUE: Databricks does not " +
					"support store response for OpenAI Responses API`. Remove " +
					"`providerOptions.openai.store`, or set it to `false`.",
			});
		}
		if (this.isReasoningFamily && openai?.forceReasoning === undefined) {
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
