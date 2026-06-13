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
// `neon-catalog-drift.test.ts` maintainer check fails if the two diverge.
// `NEON_EXTRA_MODEL_IDS` are additional ids the gateway serves that models.dev
// does not (yet) list; they are kept for autocomplete and verified to resolve
// against the gateway. The authoritative, always-current catalog is shown in
// the Neon Console under the branch's "AI Gateway" tab.

/** The models.dev `neon` catalog (canonical, unprefixed ids). */
export const NEON_MODELS_DEV_IDS = [
	// Anthropic (native Messages API)
	"claude-opus-4-7",
	"claude-opus-4-6",
	"claude-opus-4-5",
	"claude-opus-4-1",
	"claude-sonnet-4-6",
	"claude-sonnet-4-5",
	"claude-sonnet-4",
	"claude-haiku-4-5",
	// OpenAI (native Responses API)
	"gpt-5",
	"gpt-5-mini",
	"gpt-5-nano",
	"gpt-5-1",
	"gpt-5-2",
	"gpt-5-4",
	"gpt-5-4-mini",
	"gpt-5-4-nano",
	"gpt-5-5",
	// OpenAI open-weight (unified MLflow endpoint)
	"gpt-oss-120b",
	"gpt-oss-20b",
	// Google (unified MLflow endpoint)
	"gemini-3-pro",
	"gemini-3-flash",
	"gemini-3-1-pro",
	"gemini-3-1-flash-lite",
	"gemini-2-5-pro",
	"gemini-2-5-flash",
] as const;

/**
 * Ids the gateway serves that the models.dev `neon` provider does not list.
 * Verified to resolve against the gateway; retained for autocomplete. If
 * models.dev later lists one of these, the drift check flags it for promotion
 * into `NEON_MODELS_DEV_IDS`.
 */
export const NEON_EXTRA_MODEL_IDS = [
	// Anthropic (native Messages API)
	"claude-opus-4-8",
	// OpenAI (native Responses API) — Codex is served only natively
	"gpt-5-2-codex",
	"gpt-5-3-codex",
	"gpt-5-5-pro",
	// Google (unified MLflow endpoint)
	"gemini-3-5-flash",
	"gemma-3-12b",
	// Meta (unified MLflow endpoint)
	"llama-4-maverick",
	"meta-llama-3-3-70b-instruct",
	"meta-llama-3-1-8b-instruct",
	// Alibaba (unified MLflow endpoint)
	"qwen3-next-80b-a3b-instruct",
	"qwen35-122b-a10b",
] as const;

/** A known Neon AI Gateway model id (models.dev catalog + gateway extras). */
export type NeonKnownModelId =
	| (typeof NEON_MODELS_DEV_IDS)[number]
	| (typeof NEON_EXTRA_MODEL_IDS)[number];

/**
 * A Neon AI Gateway model id. Known ids are listed for autocomplete; any other
 * id (e.g. a brand-new model, or the legacy `databricks-` prefixed form) is
 * accepted via the `(string & {})` fallback.
 */
export type NeonChatModelId = NeonKnownModelId | (string & {});
