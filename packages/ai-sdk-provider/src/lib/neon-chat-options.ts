// Models served by the Neon AI Gateway. Anthropic and OpenAI models are routed
// to their provider-native endpoints; everything else uses the unified MLflow
// (OpenAI-compatible) endpoint.
//
// Ids use the canonical Neon (unprefixed) form, matching the `neon` provider on
// models.dev. The gateway also accepts the legacy `databricks-` prefixed form
// (the `databricks` provider on models.dev), which still resolves via the
// `(string & {})` fallback on `NeonChatModelId`.
//
// `NEON_MODELS_DEV_IDS` mirrors the models.dev `neon` catalog exactly — the
// `neon-catalog-drift.test.ts` maintainer check fails if the two diverge. The
// authoritative, always-current catalog is shown in the Neon Console under the
// branch's "AI Gateway" tab.
//
// There is deliberately no second list for ids the gateway serves ahead of
// models.dev. Such an id already works — `NeonChatModelId` accepts any string —
// so a hand-maintained list would buy autocomplete for a few days at the cost of
// a surface that silently rots, which is what happened last time. The fix for a
// gateway model missing here is to add it to models.dev; Orbit's catalog-parity
// job reports that gap daily.

/** The models.dev `neon` catalog (canonical, unprefixed ids). */
export const NEON_MODELS_DEV_IDS = [
	// Anthropic (native Messages API)
	"claude-fable-5",
	"claude-haiku-4-5",
	"claude-opus-4-1",
	"claude-opus-4-5",
	"claude-opus-4-6",
	"claude-opus-4-7",
	"claude-opus-4-8",
	"claude-opus-5",
	"claude-sonnet-4-5",
	"claude-sonnet-4-6",
	"claude-sonnet-5",
	// OpenAI (native Responses API)
	"gpt-5",
	"gpt-5-1",
	"gpt-5-2",
	"gpt-5-3-codex",
	"gpt-5-4",
	"gpt-5-4-mini",
	"gpt-5-4-nano",
	"gpt-5-5",
	"gpt-5-5-pro",
	"gpt-5-6-luna",
	"gpt-5-6-sol",
	"gpt-5-6-terra",
	"gpt-5-mini",
	"gpt-5-nano",
	// OpenAI open-weight (unified MLflow endpoint)
	"gpt-oss-120b",
	"gpt-oss-20b",
	// Google (unified MLflow endpoint)
	"gemini-3-1-flash-lite",
	"gemini-3-1-pro",
	"gemini-3-5-flash",
	"gemini-3-5-flash-lite",
	"gemini-3-6-flash",
	"gemini-3-flash",
	"gemma-3-12b",
	// Meta (unified MLflow endpoint)
	"llama-4-maverick",
	"meta-llama-3-1-8b-instruct",
	"meta-llama-3-3-70b-instruct",
	// Alibaba (unified MLflow endpoint)
	"qwen3-next-80b-a3b-instruct",
	"qwen35-122b-a10b",
	// Zhipu (unified MLflow endpoint)
	"glm-5-2",
	// Thinking Machines (unified MLflow endpoint)
	"inkling",
	// Moonshot (unified MLflow endpoint)
	"kimi-k3",
] as const;

/** A known Neon AI Gateway model id. */
export type NeonKnownModelId = (typeof NEON_MODELS_DEV_IDS)[number];

/**
 * A Neon AI Gateway model id. Known ids are listed for autocomplete; any other
 * id (e.g. a brand-new model, or the legacy `databricks-` prefixed form) is
 * accepted via the `(string & {})` fallback.
 */
export type NeonChatModelId = NeonKnownModelId | (string & {});
