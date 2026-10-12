/** One PostgreSQL text-format Bind parameter in a prepared live query. */
export interface PreparedLiveQueryParameter {
	/** PostgreSQL type OID hint, or `0` to request SQL-context inference. */
	readonly typeOid: number;
	/** PostgreSQL text-format value, or `null` for SQL `NULL`. */
	readonly value: string | null;
}

/** Adapter-independent query encrypted into a live-query capability. */
export interface PreparedLiveQuery {
	/** Parameterized SQL. Adapters must never interpolate runtime values here. */
	readonly sql: string;
	/** PostgreSQL text-format Bind values and type hints in placeholder order. */
	readonly parameters: readonly PreparedLiveQueryParameter[];
}

/**
 * Converts an ORM-native query into the prepared live-query representation.
 *
 * @typeParam Query - Query object accepted by the adapter.
 */
export interface RealtimeAdapter<Query> {
	/**
	 * Convert an adapter-native query into parameterized SQL and text-format
	 * parameter values. Adapters may supply PostgreSQL type OID hints; `0`
	 * requests inference. The proxy supplies result types.
	 *
	 * @param query - Concrete, fully bound query to prepare.
	 */
	prepare(query: Query): PreparedLiveQuery;
}

/**
 * Encode an already unambiguous scalar as a PostgreSQL text-format parameter.
 *
 * This low-level helper is intended for adapter authors. Application code
 * using raw SQL should prefer {@link pgParam} for ambiguous PostgreSQL types.
 *
 * @param value - Scalar value, or `null` for SQL `NULL`.
 * @param typeOid - PostgreSQL type OID hint, or `0` for SQL-context inference.
 * @returns An immutable prepared parameter.
 */
export function encodeTextParameter(
	value: string | number | boolean | bigint | null,
	typeOid = 0,
): PreparedLiveQueryParameter {
	return Object.freeze({
		typeOid,
		value: value === null ? null : String(value),
	});
}
