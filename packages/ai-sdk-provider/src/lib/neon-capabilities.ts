import type {
	LanguageModelV3CallOptions,
	LanguageModelV3StreamPart,
	SharedV3ProviderOptions,
	SharedV3Warning,
} from "@ai-sdk/provider";
import { getNeonModelCapabilities } from "./neon-model-capabilities.js";

/**
 * Drop call options the resolved model's upstream backend does not accept and
 * collect a warning for each, so callers get a clear signal instead of a hard
 * `400` from the gateway.
 */
const PENALTY_REASON =
	'Only Gemini accepts penalties on the Neon AI Gateway\'s unified endpoint; every other family returns `parameter "frequency_penalty" must be equal to 0`.';
const GENERIC_REASON =
	"The Neon AI Gateway rejects this parameter for this model.";
const REASONING_EFFORT_REASON =
	"This model does not take the OpenAI `reasoning_effort` field.";

export function applyNeonCapabilities(
	modelId: string,
	options: LanguageModelV3CallOptions,
): { options: LanguageModelV3CallOptions; warnings: SharedV3Warning[] } {
	const caps = getNeonModelCapabilities(modelId);
	const warnings: SharedV3Warning[] = [];
	const patch: Partial<LanguageModelV3CallOptions> = {};

	// The AI SDK already prints the provider, the model id and the feature name
	// ahead of `details`, so this says only what those cannot: why the gateway
	// refuses it, and what to reach for instead. `caps.family` is deliberately not
	// interpolated — it is the literal string "other" for gpt-oss, Qwen, Gemma,
	// glm-5-2 and inkling, which reads as "for other model".
	const dropUnsupported = (feature: string, reason: string) => {
		warnings.push({
			type: "unsupported",
			feature,
			details: `${reason} It was dropped rather than sent, which would return a 400.`,
		});
	};

	const samplingReason = caps.claudeSamplingUnrecognized
		? "This Claude version was not recognised, and Claude 4.7 and newer reject sampling parameters, so it was treated as one of those."
		: caps.family === "anthropic"
			? "Claude 4.7 and newer reject sampling parameters; those models are steered with reasoning effort instead."
			: "The Neon AI Gateway rejects this parameter for this model.";

	if (options.temperature != null && !caps.supportsTemperature) {
		patch.temperature = undefined;
		dropUnsupported("temperature", samplingReason);
	}
	if (options.topP != null && !caps.supportsTopP) {
		patch.topP = undefined;
		dropUnsupported("topP", samplingReason);
	}

	// Anthropic-style models accept only one of temperature / topP.
	const effectiveTemperature =
		"temperature" in patch ? patch.temperature : options.temperature;
	const effectiveTopP = "topP" in patch ? patch.topP : options.topP;
	if (
		caps.temperatureTopPMutuallyExclusive &&
		effectiveTemperature != null &&
		effectiveTopP != null
	) {
		patch.topP = undefined;
		warnings.push({
			type: "compatibility",
			feature: "topP",
			details: `${caps.family} models accept only one of temperature or topP; topP was dropped.`,
		});
	}

	if (options.frequencyPenalty != null && !caps.supportsPenalties) {
		patch.frequencyPenalty = undefined;
		dropUnsupported("frequencyPenalty", PENALTY_REASON);
	}
	if (options.presencePenalty != null && !caps.supportsPenalties) {
		patch.presencePenalty = undefined;
		dropUnsupported("presencePenalty", PENALTY_REASON);
	}
	if (options.seed != null && !caps.supportsSeed) {
		patch.seed = undefined;
		dropUnsupported("seed", GENERIC_REASON);
	}

	if (options.stopSequences != null && !caps.supportsStopSequences) {
		patch.stopSequences = undefined;
		dropUnsupported("stopSequences", GENERIC_REASON);
	}

	if (!caps.supportsReasoningEffort) {
		const { providerOptions } = options;
		const hasProviderEffort =
			providerOptions != null &&
			Object.values(providerOptions).some(
				(group) =>
					"reasoningEffort" in group && group.reasoningEffort != null,
			);

		if (hasProviderEffort) {
			dropUnsupported("reasoningEffort", REASONING_EFFORT_REASON);
			if (providerOptions != null) {
				const cleaned: SharedV3ProviderOptions = {};
				for (const [key, group] of Object.entries(providerOptions)) {
					if ("reasoningEffort" in group) {
						const { reasoningEffort: _removed, ...rest } = group;
						cleaned[key] = rest;
					} else {
						cleaned[key] = group;
					}
				}
				patch.providerOptions = cleaned;
			}
		}
	}

	if (Object.keys(patch).length === 0) {
		return { options, warnings };
	}
	return { options: { ...options, ...patch }, warnings };
}

/**
 * Merge additional warnings into the `stream-start` part of a model stream.
 */
export function mergeStreamStartWarnings(extra: SharedV3Warning[]) {
	let merged = false;
	return new TransformStream<
		LanguageModelV3StreamPart,
		LanguageModelV3StreamPart
	>({
		transform(part, controller) {
			if (!merged && part.type === "stream-start") {
				merged = true;
				controller.enqueue({
					...part,
					warnings: [...extra, ...part.warnings],
				});
			} else {
				controller.enqueue(part);
			}
		},
	});
}
