// Models served by the Neon AI Gateway. Anthropic and OpenAI models are routed
// to their provider-native endpoints; everything else uses the unified MLflow
// (OpenAI-compatible) endpoint.
//
// Ids use the canonical Neon (unprefixed) form, matching
// https://neon.com/models.json. The gateway also accepts the legacy
// `databricks-` prefixed form, which still resolves via the `(string & {})`
// fallback on `NeonChatModelId`.
//
// `NEON_MODELS_DEV_IDS` mirrors neon.com/models.json `neon.models` exactly —
// `neon-catalog-drift.test.ts` fails if the two diverge. A branch's live list
// is `GET $NEON_AI_GATEWAY_BASE_URL/v1/models`. There is deliberately no second
// list for ids the gateway serves ahead of the published catalog: such an id
// already works because `NeonChatModelId` accepts any string.

/** Published catalog ids from https://neon.com/models.json (canonical, unprefixed). */
export const NEON_MODELS_DEV_IDS = [
	// Anthropic (native Messages API)
	"claude-fable-5",
	"claude-fable-5-1",
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
	"gpt-6-astra",
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
	"glm-5-3-flash",
	// xAI (unified MLflow endpoint)
	"grok-4-6",
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
