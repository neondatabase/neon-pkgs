/**
 * The Convex validator tree, as it appears in the JSON returned by
 * `SchemaDefinition.export()` (verified against convex 1.47.0).
 *
 * Note the `fieldType` type names: `v.int64()` serializes as `{"type":"bigint"}`
 * (not `"int64"`), and `v.optional(x)` is NOT a wrapper node -- it appears as
 * `optional: true` on the owning field entry with `fieldType` set to the inner
 * validator.
 */
export type ConvexValidator =
	| { type: "string" }
	| { type: "number" }
	| { type: "boolean" }
	| { type: "bigint" }
	| { type: "bytes" }
	| { type: "null" }
	| { type: "any" }
	// `v.commitTs()` serializes as `{"type":"commitTs"}` (verified against convex
	// 1.47.0): an internal monotonic commit timestamp with no portable Postgres
	// type. Approximated as `bigint` by the type mapper.
	| { type: "commitTs" }
	| { type: "id"; tableName: string }
	| { type: "array"; value: ConvexValidator }
	| { type: "object"; value: Record<string, ConvexFieldEntry> }
	| { type: "record"; keys?: ConvexValidator; values?: unknown }
	| { type: "union"; value: ConvexValidator[] }
	| { type: "literal"; value: string | number | boolean | null };

/** One field inside an object validator's `value` map. */
export interface ConvexFieldEntry {
	fieldType: ConvexValidator;
	optional: boolean;
}

/** One index declared with `.index(descriptor, [fields])`. */
export interface ConvexIndexDef {
	indexDescriptor: string;
	/** Declared columns only; the implicit trailing `_creationTime` is absent. */
	fields: string[];
}

/**
 * One full-text search index declared with
 * `.searchIndex(descriptor, { searchField, filterFields })`.
 */
export interface ConvexSearchIndex {
	/** The index descriptor (`indexDescriptor` in the export). */
	name: string;
	/** The single text field the index searches. */
	searchField: string;
	/** Fields the index can additionally filter on. */
	filterFields: string[];
}

/**
 * One vector index declared with
 * `.vectorIndex(descriptor, { vectorField, dimensions, filterFields })`.
 */
export interface ConvexVectorIndex {
	/** The index descriptor (`indexDescriptor` in the export). */
	name: string;
	/** The field holding the embedding array. */
	vectorField: string;
	/** The embedding dimensionality (e.g. `1536`). */
	dimensions: number;
	/** Fields the index can additionally filter on. */
	filterFields: string[];
}

/** The raw shape of `JSON.parse(SchemaDefinition.export())`. */
export interface ExportedSchema {
	tables: ExportedTable[];
	schemaValidation: boolean;
}

export interface ExportedTable {
	tableName: string;
	indexes?: ConvexIndexDef[];
	searchIndexes?: Array<{
		indexDescriptor?: string;
		searchField?: string;
		filterFields?: string[];
	}>;
	vectorIndexes?: Array<{
		indexDescriptor?: string;
		vectorField?: string;
		dimensions?: number;
		filterFields?: string[];
	}>;
	documentType: ConvexValidator;
}

/** A single normalized user column (excludes `_id` / `_creationTime`). */
export interface ConvexColumn {
	/** Original Convex field name, used for `doc->>'...'` lookups. */
	name: string;
	validator: ConvexValidator;
	optional: boolean;
}

/** A single normalized Convex table. */
export interface ConvexTable {
	/** Original Convex table name, used to read `<name>/documents.jsonl`. */
	name: string;
	columns: ConvexColumn[];
	indexes: ConvexIndexDef[];
	/** Full-text search indexes, emitted as Lakebase BM25 indexes. */
	searchIndexes: ConvexSearchIndex[];
	/** Vector indexes, emitted as Lakebase ANN indexes over a `vector` column. */
	vectorIndexes: ConvexVectorIndex[];
	/**
	 * `true` when the table has no declared field shape (schemaless, or
	 * `documentType` is `any`). Such a table falls back to `id`, `created_at`,
	 * and a single `doc jsonb` column.
	 */
	schemaless: boolean;
}

/** A parsed Convex schema: the input to every pure generation helper. */
export interface ConvexSchema {
	tables: ConvexTable[];
	schemaValidation: boolean;
}
