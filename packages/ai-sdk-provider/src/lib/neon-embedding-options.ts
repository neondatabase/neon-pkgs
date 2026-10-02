// Embedding models served on the Neon AI Gateway's OpenAI-compatible
// `/v1/embeddings` endpoint. Mirrors the `"type": "embedding"` entries of
// https://neon.com/models.json — `neon-catalog-drift.test.ts` fails if the two
// diverge.

/** Published embedding model ids from https://neon.com/models.json. */
export const NEON_EMBEDDING_MODEL_IDS = [
	"gte-large-en",
	"qwen3-embedding-0-6b",
] as const;

/**
 * A Neon AI Gateway embedding model id. Known ids are listed for autocomplete;
 * any other id is accepted via the `(string & {})` fallback.
 */
export type NeonEmbeddingModelId =
	| (typeof NEON_EMBEDDING_MODEL_IDS)[number]
	| (string & {});

/** The gateway rejects an embeddings request with more inputs than this. */
export const NEON_MAX_EMBEDDINGS_PER_CALL = 150;
