export type NeonModelFamily =
	| "anthropic"
	| "google"
	| "openai"
	| "meta"
	| "other";

/**
 * Which gateway endpoint a model should be routed to.
 *
 * - `anthropic`: native Messages API — streaming structured output + native reasoning.
 * - `openai`: native Responses API — models served only natively (e.g. Codex),
 *   native reasoning, and the image-generation tool.
 * - `mlflow`: the unified, OpenAI-compatible endpoint (the fallback). Gemini is
 *   routed here because the gateway's native Gemini endpoint does not support
 *   streaming (`streamGenerateContent` is rejected).
 */
export type NeonModelRoute = "anthropic" | "openai" | "mlflow";

export function getNeonModelRoute(modelId: string): NeonModelRoute {
	const id = modelId.toLowerCase();
	if (id.includes("claude")) {
		return "anthropic";
	}
	// OpenAI proprietary models (gpt-4/gpt-5 families, Codex) are served only via
	// the native Responses API. `gpt-oss` is open-weight and served on the
	// unified chat endpoint, so it is intentionally excluded here.
	if (
		(id.includes("gpt-") && !id.includes("gpt-oss")) ||
		id.includes("codex")
	) {
		return "openai";
	}
	return "mlflow";
}

export interface NeonModelCapabilities {
	family: NeonModelFamily;
	supportsTemperature: boolean;
	supportsTopP: boolean;
	/**
	 * Whether `temperature` and `topP` may be sent together. Anthropic models
	 * accept only one of the two.
	 */
	temperatureTopPMutuallyExclusive: boolean;
	supportsPenalties: boolean;
	supportsSeed: boolean;
	supportsStopSequences: boolean;
	supportsReasoningEffort: boolean;
	/**
	 * True when a `claude-*` id could not be parsed into a version and was
	 * assumed to be new. The sampling restriction is then a precaution rather
	 * than something measured, and the warning says so instead of asserting a
	 * capability nobody checked.
	 */
	claudeSamplingUnrecognized?: boolean;
}

/**
 * Gemini models the gateway rejects penalties on, by measurement. Their older
 * siblings accept penalties, so this cannot be derived from the id.
 */
const GEMINI_NO_PENALTIES = ["gemini-3-5-flash-lite", "gemini-3-6-flash"];

const PERMISSIVE: Omit<NeonModelCapabilities, "family"> = {
	supportsTemperature: true,
	supportsTopP: true,
	temperatureTopPMutuallyExclusive: false,
	supportsPenalties: true,
	supportsSeed: true,
	supportsStopSequences: true,
	supportsReasoningEffort: true,
};

/**
 * Whether a Claude id predates the 4.7 cutoff where the gateway stopped
 * accepting `temperature` and `top_p`. Ids look like `claude-<tier>-<major>` or
 * `claude-<tier>-<major>-<minor>`, optionally behind the legacy `databricks-`
 * prefix. An id we cannot parse is treated as new, which is the safe direction.
 */
function claudeVersion(id: string): { major: number; minor: number } | null {
	// Anchored: `claude-opus-4-beta` and `claude-opus-4.7` must not match their
	// leading digits and be read as old models. A dated id such as
	// `claude-3-5-sonnet-20241022` does not parse either, and is reported as
	// unrecognised rather than silently classified.
	const match = /^(?:databricks-)?claude-[a-z]+-(\d+)(?:-(\d+))?$/.exec(id);
	if (!match) {
		return null;
	}
	return {
		major: Number(match[1]),
		minor: match[2] === undefined ? 0 : Number(match[2]),
	};
}

/**
 * Heuristic, prefix-based capability detection for MLflow-routed Neon models.
 *
 * The unified endpoint proxies to heterogeneous upstream providers, each of
 * which accepts a different subset of the OpenAI-style parameters the AI SDK
 * emits. Sending a parameter an upstream rejects results in a hard `400`, so we
 * strip the parameters a family is known to reject and surface a warning
 * instead. Unknown/untested models stay permissive (passed through unchanged).
 */
export function getNeonModelCapabilities(
	modelId: string,
): NeonModelCapabilities {
	const id = modelId.toLowerCase();

	// Anthropic (Claude): rejects penalties and seed, accepts only one of
	// temperature/topP, and rejects the OpenAI `reasoning_effort` field.
	//
	// From Claude 4.7 onward the gateway also rejects non-default sampling
	// entirely — `does not support the temperature parameter` /
	// `does not support sampling parameters: top_p` — because those models are
	// steered with `output_config.effort` instead. Measured: 4.1/4.5/4.6 accept
	// both, 4.7/4.8/5 reject both, and every id accepts the default
	// `temperature: 1.0`. A version comparison rather than a list of ids, so a
	// future Claude inherits the restriction: dropping a parameter the model
	// would have accepted costs a warning, claiming one it rejects costs a 400.
	if (id.includes("claude")) {
		const version = claudeVersion(id);
		const sampling =
			version !== null &&
			(version.major < 4 || (version.major === 4 && version.minor <= 6));
		return {
			family: "anthropic",
			supportsTemperature: sampling,
			supportsTopP: sampling,
			temperatureTopPMutuallyExclusive: true,
			supportsPenalties: false,
			supportsSeed: false,
			supportsStopSequences: true,
			supportsReasoningEffort: false,
			...(version === null ? { claudeSamplingUnrecognized: true } : {}),
		};
	}

	// Google (Gemini): accepts standard sampling params but rejects the OpenAI
	// `reasoning_effort` field (not part of Gemini's generation config).
	//
	// Newer Gemini models are stricter, and not in a way the id predicts: the
	// gateway rejects penalties on `gemini-3-5-flash-lite` while accepting them
	// on `gemini-3-1-flash-lite`, so neither the version nor the `-lite` suffix
	// is the rule. `gemini-3-6-flash` refuses temperature and topP outright
	// ("does not support the temperature parameter"). Both are listed by id
	// because that is what was measured; a new Gemini model inherits the
	// permissive default until someone measures it.
	if (id.includes("gemini")) {
		const strict = GEMINI_NO_PENALTIES.some((m) => id.includes(m));
		return {
			family: "google",
			...PERMISSIVE,
			supportsTemperature: !id.includes("gemini-3-6-flash"),
			supportsTopP: !id.includes("gemini-3-6-flash"),
			supportsPenalties: !strict,
			supportsReasoningEffort: false,
		};
	}

	// OpenAI GPT-5 reasoning family (routed to the native Responses API). The
	// Responses model strips parameters the Responses API doesn't accept
	// (penalties, seed, stop), but its reasoning-model detection matches the bare
	// model id (`gpt-5`), which the gateway's optional `databricks-` prefix can
	// defeat. So we only handle the temperature/topP restriction here: the
	// original gpt-5 / gpt-5-mini / gpt-5-nano require the default temperature and
	// reject topP, while gpt-5.1+ (a minor version digit follows) accept them
	// again. The regex matches both prefixed and unprefixed ids.
	if (/gpt-5/.test(id)) {
		const hasMinorVersion = /gpt-5[.-]\d/.test(id);
		return {
			family: "openai",
			supportsTemperature: hasMinorVersion,
			supportsTopP: hasMinorVersion,
			temperatureTopPMutuallyExclusive: false,
			supportsPenalties: true,
			supportsSeed: true,
			supportsStopSequences: true,
			supportsReasoningEffort: true,
		};
	}

	// Meta (Llama): rejects penalties and seed; accepts sampling params and stop.
	if (id.includes("llama")) {
		return {
			family: "meta",
			supportsTemperature: true,
			supportsTopP: true,
			temperatureTopPMutuallyExclusive: false,
			supportsPenalties: false,
			supportsSeed: false,
			supportsStopSequences: true,
			supportsReasoningEffort: true,
		};
	}

	// Everything else on the unified endpoint rejects penalties with
	// `parameter "frequency_penalty" must be equal to 0`. Only the older Gemini
	// models, handled above, accept them. Seed and stop vary, so each family
	// carries what was measured rather than inheriting a guess.
	if (id.includes("gpt-oss")) {
		return {
			family: "other",
			...PERMISSIVE,
			supportsPenalties: false,
			supportsSeed: false,
			supportsStopSequences: false,
		};
	}

	if (id.includes("qwen") || id.includes("gemma")) {
		return {
			family: "other",
			...PERMISSIVE,
			supportsPenalties: false,
			supportsSeed: false,
		};
	}

	if (id.includes("glm") || id.includes("inkling") || id.includes("kimi")) {
		return { family: "other", ...PERMISSIVE, supportsPenalties: false };
	}

	return { family: "other", ...PERMISSIVE };
}
