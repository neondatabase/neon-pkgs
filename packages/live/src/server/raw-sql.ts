import {
	encodeTextParameter,
	type PreparedAuthorizationQuery,
	type PreparedLiveQueryParameter,
} from "./adapter.js";
import {
	isTypedRawSqlParameter,
	type TypedRawSqlParameter,
} from "./raw-parameter.js";

const RAW_SQL_QUERY = Symbol("neon-live.raw-sql-query");

/** A JavaScript value accepted as a PostgreSQL text-format parameter. */
export type RawSqlParameter =
	| string
	| number
	| boolean
	| bigint
	| null
	| TypedRawSqlParameter;

/** Parameterized raw PostgreSQL SQL carrying its declared result-row type. */
export interface RawSqlQuery<Row> extends PreparedAuthorizationQuery {
	/** @internal Private brand used to distinguish explicit raw SQL. */
	readonly [RAW_SQL_QUERY]: true;
	/** @internal Carries the declared row type without adding runtime data. */
	readonly __row?: Row;
}

/**
 * Define a typed raw SQL query. Values are sent separately from the SQL. Bare
 * values use type OID `0`, asking PostgreSQL to infer their types from the
 * SQL. Use {@link pgParam} when a value needs an explicit PostgreSQL encoder
 * and built-in type OID. JavaScript `null` represents SQL `NULL`.
 *
 * @typeParam Row - Row returned by the query.
 * @param sql - Parameterized SQL using PostgreSQL placeholders such as `$1`.
 * @param parameters - Values in placeholder order.
 * @returns An immutable query descriptor accepted by `authorize()`.
 */
export function rawSql<Row>(
	sql: string,
	parameters: readonly RawSqlParameter[] = [],
): RawSqlQuery<Row> {
	return Object.freeze({
		[RAW_SQL_QUERY]: true as const,
		sql,
		parameters: Object.freeze(parameters.map(encodeRawSqlParameter)),
	});
}

export function prepareRawSqlQuery(
	query: RawSqlQuery<unknown>,
): PreparedAuthorizationQuery {
	return Object.freeze({
		sql: query.sql,
		parameters: Object.freeze([...query.parameters]),
	});
}

export function isRawSqlQuery(query: unknown): query is RawSqlQuery<unknown> {
	return (
		typeof query === "object" &&
		query !== null &&
		RAW_SQL_QUERY in query &&
		query[RAW_SQL_QUERY] === true
	);
}

function encodeRawSqlParameter(
	parameter: RawSqlParameter,
): PreparedLiveQueryParameter {
	if (isTypedRawSqlParameter(parameter)) {
		return Object.freeze({
			typeOid: parameter.typeOid,
			value: parameter.value,
		});
	}
	if (
		parameter === null ||
		typeof parameter === "string" ||
		typeof parameter === "number" ||
		typeof parameter === "boolean" ||
		typeof parameter === "bigint"
	) {
		return encodeTextParameter(parameter);
	}
	throw new Error("Invalid Neon Live raw SQL parameter");
}
