import type {
	LanguageModelV3CallOptions,
	LanguageModelV3StreamPart,
	SharedV3ProviderOptions,
	SharedV3Warning,
} from "@ai-sdk/provider";
import { getNeonModelCapabilities } from "./neon-model-capabilities.js";

const PENALTY_DETAILS =
	"The request was sent without it. Check getNeonModelCapabilities(id).supportsPenalties before setting penalties.";
const GENERIC_DETAILS =
	"The request was sent without it. Call getNeonModelCapabilities(id) to see which sampling parameters this model takes, or steer it through the prompt.";
const REASONING_EFFORT_DETAILS =
	"The request was sent without it. Claude takes providerOptions.anthropic.effort instead.";

/**
 * Drop call options the resolved model's upstream backend does not accept and
 * collect a warning for each, so callers get a clear signal instead of a hard
 * `400` from the gateway.
 */
export function applyNeonCapabilities(
	modelId: string,
	options: LanguageModelV3CallOptions,
): { options: LanguageModelV3CallOptions; warnings: SharedV3Warning[] } {
	const caps = getNeonModelCapabilities(modelId);
	const warnings: SharedV3Warning[] = [];
	const patch: Partial<LanguageModelV3CallOptions> = {};

	// The AI SDK prints the provider, the model id and the feature name ahead of
	// `details`, so each reason says only what those cannot: why the gateway
	// refuses it, and what to use instead. Each carries its own "was dropped"
	// clause rather than a shared suffix — appending one everywhere restated the
	// penalty reason and asserted a 400 for the unrecognised case, which is the
	// overstatement this wording exists to avoid.
	const drop = (
		feature: string,
		details: string,
		type: "unsupported" | "compatibility" = "unsupported",
	) => {
		warnings.push({ type, feature, details });
	};

	// Precautionary rather than measured, so it is flagged as a compatibility
	// choice: the SDK renders `unsupported` as a flat "is not supported", which
	// would contradict the hedge in the sentence that follows it.
	const unrecognizedClaude = caps.claudeSamplingUnrecognized === true;
	const samplingDetails = unrecognizedClaude
		? "This Claude version was not recognised. Claude 4.7 and newer reject sampling parameters, so it was dropped as a precaution; set `providerOptions.anthropic.effort` instead."
		: caps.family === "anthropic"
			? "Claude 4.7 and newer reject sampling parameters, so it was dropped rather than sent. Use `providerOptions.anthropic.effort` (low | medium | high | xhigh | max) to steer these models."
			: "The Neon AI Gateway rejects this parameter for this model, so it was dropped rather than sent.";
	const samplingType = unrecognizedClaude ? "compatibility" : "unsupported";

	if (options.temperature != null && !caps.supportsTemperature) {
		patch.temperature = undefined;
		drop("temperature", samplingDetails, samplingType);
	}
	if (options.topP != null && !caps.supportsTopP) {
		patch.topP = undefined;
		drop("topP", samplingDetails, samplingType);
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
			details:
				"Anthropic models accept only one of temperature or topP; topP was dropped and temperature kept.",
		});
	}

	if (options.frequencyPenalty != null && !caps.supportsPenalties) {
		patch.frequencyPenalty = undefined;
		drop("frequencyPenalty", PENALTY_DETAILS);
	}
	if (options.presencePenalty != null && !caps.supportsPenalties) {
		patch.presencePenalty = undefined;
		drop("presencePenalty", PENALTY_DETAILS);
	}
	if (options.seed != null && !caps.supportsSeed) {
		patch.seed = undefined;
		drop("seed", GENERIC_DETAILS);
	}

	if (options.stopSequences != null && !caps.supportsStopSequences) {
		patch.stopSequences = undefined;
		drop("stopSequences", GENERIC_DETAILS);
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
			drop("reasoningEffort", REASONING_EFFORT_DETAILS);
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
