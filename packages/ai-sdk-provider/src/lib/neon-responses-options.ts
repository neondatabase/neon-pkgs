import {
	type LanguageModelV3CallOptions,
	UnsupportedFunctionalityError,
} from "@ai-sdk/provider";

/**
 * Request defaults for the Neon AI Gateway's Responses route.
 *
 * `store: false` is the one value this gateway accepts, not a preference. It
 * serves the Responses API statelessly and keeps no items — a response comes
 * back with `"store": false` even when the request never set it. Left alone the
 * shared OpenAI model assumes stored-item semantics and replays earlier
 * reasoning as `{ type: "item_reference", id }`, which nothing upstream can
 * resolve; the gateway answers `502 INTERNAL_ERROR` on the second step of a
 * tool loop, after the first has already succeeded. Sending `false` makes the
 * model inline the encrypted reasoning instead.
 *
 * Since no other value can work, an explicit `store` that is not `false` is
 * refused rather than sent: the request would come back `400
 * INVALID_PARAMETER_VALUE` after a round trip, and quietly forcing it to
 * `false` would be the wrong kind of quiet for a data-retention flag. A
 * type-level constraint is not available — `providerOptions` is
 * `Record<string, JSONObject>`, so a provider cannot narrow it at the call
 * site.
 *
 * `forceReasoning: true` covers a gap in the shared model's own detection,
 * which matches a bare `gpt-5` prefix. The gateway also accepts the legacy
 * `databricks-` form, and `databricks-gpt-5-2` fails that match while still
 * being a reasoning model.
 */

/** Models the gateway serves as reasoning models on this route. */
export function isReasoningModelId(modelId: string): boolean {
	return /gpt-5/.test(modelId.toLowerCase());
}

/**
 * Apply the route's defaults to one call, or throw when a caller asked for
 * something the gateway cannot do. Returns the options unchanged when there is
 * nothing to add.
 */
export function withResponsesGatewayDefaults(
	modelId: string,
	options: LanguageModelV3CallOptions,
): LanguageModelV3CallOptions {
	const openai = options.providerOptions?.openai;
	const defaults: Record<string, boolean> = {};

	// `undefined` counts as unset rather than as a choice: it serializes away,
	// so `{ store: undefined }` and `{}` are the same request on the wire.
	if (openai?.store === undefined) {
		defaults.store = false;
	} else if (openai.store === true || openai.store === null) {
		throw new UnsupportedFunctionalityError({
			functionality: "storing responses (providerOptions.openai.store)",
			message:
				"The Neon AI Gateway serves the Responses API statelessly and does " +
				"not store response items, so `store` must be `false` or omitted " +
				`(received ${String(openai.store)}). Sending it reaches the ` +
				"gateway as `400 INVALID_PARAMETER_VALUE: Databricks does not " +
				"support store response for OpenAI Responses API`. Remove " +
				"`providerOptions.openai.store`, or set it to `false`.",
		});
	}

	// Any other type is left for the shared model's own provider-option schema
	// (`store: z.boolean().nullish()`), which rejects it locally with a type
	// error. Only `true` and `null` pass that schema and are refused by the
	// gateway, so only they need saying something about here.

	if (isReasoningModelId(modelId) && openai?.forceReasoning === undefined) {
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
