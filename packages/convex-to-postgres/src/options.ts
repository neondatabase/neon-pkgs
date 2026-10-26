/**
 * How a Convex document `_id` (an opaque ~32-char string) becomes a Postgres
 * primary key, and how `v.id(...)` references become foreign keys.
 *
 * - `"uuid"` (default): the id column is `uuid` and the value is
 *   `md5(doc->>'_id')::uuid`. A reference string hashes to the same uuid as the
 *   target row's `_id`, so foreign keys line up with no lookup table.
 * - `"text"`: the id column is `text` and the value is the Convex id verbatim.
 */
export type IdStrategy = "uuid" | "text";

/** Options shared by every schema-generation and transform helper. */
export interface GenerateOptions {
	/** Id/foreign-key representation. Defaults to `"uuid"`. */
	idStrategy?: IdStrategy;
	/**
	 * Convert camelCase Convex field and table names to snake_case Postgres
	 * identifiers (`authorId` -> `author_id`). Defaults to `true`. When `false`,
	 * names are kept verbatim and quoted where Postgres would otherwise fold
	 * them to lowercase.
	 */
	snakeCase?: boolean;
	/**
	 * Emit a `CHECK (col IN (...))` constraint for a union of string literals.
	 * Defaults to `true`.
	 */
	checkConstraints?: boolean;
	/**
	 * Text-search configuration passed to `to_tsvector(...)` for the generated
	 * `tsvector` column backing a Lakebase BM25 index. Defaults to `"english"`.
	 */
	searchLanguage?: string;
	/**
	 * pgvector operator class for the Lakebase ANN index. Defaults to
	 * `"vector_cosine_ops"` (cosine distance, the `<=>` operator).
	 */
	vectorOps?: string;
	/**
	 * BM25 `k1` term-frequency saturation parameter. Defaults to `1.2` (the
	 * Lakebase default).
	 */
	searchK1?: number;
	/**
	 * BM25 `b` length-normalization parameter. Defaults to `0.75` (the Lakebase
	 * default).
	 */
	searchB?: number;
	/**
	 * Cap on the embedding dimensionality that still gets a Lakebase ANN index.
	 * When set and a vector index exceeds it, the column is still typed
	 * `vector(<dimensions>)` but the ANN index is skipped with a warning.
	 * Defaults to `undefined` (no cap; every vector index gets an ANN index).
	 */
	maxAnnDimensions?: number;
}

/** {@link GenerateOptions} with every field resolved to its default. */
export interface ResolvedOptions {
	idStrategy: IdStrategy;
	snakeCase: boolean;
	checkConstraints: boolean;
	searchLanguage: string;
	vectorOps: string;
	searchK1: number;
	searchB: number;
	/** `undefined` means no cap. */
	maxAnnDimensions: number | undefined;
}

/** Fill in defaults for any omitted {@link GenerateOptions} field. */
export function resolveOptions(options: GenerateOptions = {}): ResolvedOptions {
	return {
		idStrategy: options.idStrategy ?? "uuid",
		snakeCase: options.snakeCase ?? true,
		checkConstraints: options.checkConstraints ?? true,
		searchLanguage: options.searchLanguage ?? "english",
		vectorOps: options.vectorOps ?? "vector_cosine_ops",
		searchK1: options.searchK1 ?? 1.2,
		searchB: options.searchB ?? 0.75,
		maxAnnDimensions: options.maxAnnDimensions,
	};
}
