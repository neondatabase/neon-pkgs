import type { PreparedLiveQueryParameter } from "./adapter.js";
import {
	normalizePostgresType,
	postgresArrayDelimiter,
	postgresArrayTypeOid,
	postgresTypeOid,
} from "./postgres-type.js";

const TYPED_RAW_SQL_PARAMETER = Symbol("neon-live.typed-raw-sql-parameter");

/** A raw SQL parameter with an explicit PostgreSQL text encoder and type hint. */
export interface TypedRawSqlParameter extends PreparedLiveQueryParameter {
	/** @internal Private brand used by {@link rawSql}. */
	readonly [TYPED_RAW_SQL_PARAMETER]: true;
}

/** PostgreSQL text encoders for values that bare raw SQL cannot disambiguate. */
export interface PostgresParameterHelpers {
	/**
	 * Use an already encoded PostgreSQL text value for a named type.
	 *
	 * A recognized built-in type supplies its stable OID. Unknown,
	 * database-specific, and extension types use OID `0` for inference.
	 *
	 * @param sqlType - PostgreSQL type name, such as `uuid` or `numeric(12, 2)`.
	 * @param value - Value already encoded in that type's PostgreSQL text format.
	 */
	text(
		sqlType: string,
		value: string | number | boolean | bigint | null,
	): TypedRawSqlParameter;

	/**
	 * Encode a JavaScript date as a PostgreSQL `date`.
	 *
	 * A `Date` uses its UTC calendar date. A string is passed through as an
	 * already encoded PostgreSQL text value.
	 */
	date(value: Date | string): TypedRawSqlParameter;

	/**
	 * Encode a JavaScript date as a UTC PostgreSQL `timestamp` without time zone.
	 *
	 * A string is passed through as an already encoded PostgreSQL text value.
	 */
	timestamp(value: Date | string): TypedRawSqlParameter;

	/**
	 * Encode a JavaScript date as a PostgreSQL `timestamptz`.
	 *
	 * A `Date` uses its ISO 8601 representation. A string is passed through as
	 * an already encoded PostgreSQL text value.
	 */
	timestamptz(value: Date | string): TypedRawSqlParameter;

	/** Encode a JavaScript value as PostgreSQL `json`. */
	json(value: unknown): TypedRawSqlParameter;

	/** Encode a JavaScript value as PostgreSQL `jsonb`. */
	jsonb(value: unknown): TypedRawSqlParameter;

	/** Encode bytes in PostgreSQL's hexadecimal `bytea` text format. */
	bytea(value: Uint8Array): TypedRawSqlParameter;

	/**
	 * Encode a possibly nested PostgreSQL array.
	 *
	 * Built-in element types supply their stable array OID; database-specific
	 * or unknown element types use OID `0`. JavaScript `null` becomes a SQL NULL
	 * array element. Values are encoded immediately, so later mutations do not
	 * affect the parameter.
	 *
	 * @param elementType - PostgreSQL element type, such as `text` or `uuid`.
	 * @param values - Array elements, which may include nested arrays.
	 */
	array(
		elementType: string,
		values: readonly unknown[],
	): TypedRawSqlParameter;
}

/** Helpers for values whose PostgreSQL text encoding or type is ambiguous. */
export const pgParam: PostgresParameterHelpers = Object.freeze({
	text(
		sqlType: string,
		value: string | number | boolean | bigint | null,
	): TypedRawSqlParameter {
		return typedParameter(
			postgresTypeOid(sqlType),
			value === null ? null : String(value),
		);
	},

	date(value: Date | string): TypedRawSqlParameter {
		return typedParameter(
			1082,
			value instanceof Date ? isoDate(value) : value,
		);
	},

	timestamp(value: Date | string): TypedRawSqlParameter {
		return typedParameter(
			1114,
			value instanceof Date ? isoTimestamp(value) : value,
		);
	},

	timestamptz(value: Date | string): TypedRawSqlParameter {
		return typedParameter(1184, value instanceof Date ? iso(value) : value);
	},

	json(value: unknown): TypedRawSqlParameter {
		return typedParameter(114, encodeJson(value));
	},

	jsonb(value: unknown): TypedRawSqlParameter {
		return typedParameter(3802, encodeJson(value));
	},

	bytea(value: Uint8Array): TypedRawSqlParameter {
		return typedParameter(17, `\\x${encodeHex(value)}`);
	},

	array(
		elementType: string,
		values: readonly unknown[],
	): TypedRawSqlParameter {
		return typedParameter(
			postgresArrayTypeOid(elementType),
			encodeArray(
				values,
				normalizePostgresType(elementType),
				postgresArrayDelimiter(elementType),
			),
		);
	},
});

/**
 * Test whether a value was created by one of the {@link pgParam} helpers.
 *
 * This low-level helper is intended for query-adapter authors. Applications
 * should normally pass the wrapper directly to the adapter or {@link rawSql}.
 */
export function isTypedRawSqlParameter(
	value: unknown,
): value is TypedRawSqlParameter {
	return (
		typeof value === "object" &&
		value !== null &&
		TYPED_RAW_SQL_PARAMETER in value &&
		value[TYPED_RAW_SQL_PARAMETER] === true
	);
}

function typedParameter(
	typeOid: number,
	value: string | null,
): TypedRawSqlParameter {
	return Object.freeze({
		[TYPED_RAW_SQL_PARAMETER]: true as const,
		typeOid,
		value,
	});
}

function iso(value: Date): string {
	if (!Number.isFinite(value.getTime())) {
		throw new Error(
			"Invalid Date passed to a Realtime PostgreSQL parameter",
		);
	}
	return value.toISOString();
}

function isoDate(value: Date): string {
	return iso(value).slice(0, 10);
}

function isoTimestamp(value: Date): string {
	return iso(value).slice(0, -1).replace("T", " ");
}

function encodeJson(value: unknown): string {
	try {
		const encoded = JSON.stringify(value);
		if (encoded === undefined) throw new Error();
		return encoded;
	} catch {
		throw new Error(
			"Value cannot be encoded as a Realtime PostgreSQL JSON parameter",
		);
	}
}

function encodeArray(
	values: readonly unknown[],
	elementType: string,
	delimiter: string,
): string {
	return `{${values
		.map((value) => encodeArrayValue(value, elementType, delimiter))
		.join(delimiter)}}`;
}

function encodeArrayValue(
	value: unknown,
	elementType: string,
	delimiter: string,
): string {
	if (Array.isArray(value)) return encodeArray(value, elementType, delimiter);
	if (value === null) return "NULL";

	let encoded: string;
	if (elementType === "json" || elementType === "jsonb") {
		encoded = encodeJson(value);
	} else if (elementType === "bytea" && value instanceof Uint8Array) {
		encoded = `\\x${encodeHex(value)}`;
	} else if (value instanceof Date) {
		encoded = encodeArrayDate(value, elementType);
	} else if (
		typeof value === "string" ||
		typeof value === "number" ||
		typeof value === "boolean" ||
		typeof value === "bigint"
	) {
		encoded = String(value);
	} else {
		throw new Error(
			`Value cannot be encoded as a Realtime PostgreSQL ${elementType} array element`,
		);
	}

	return `"${encoded.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function encodeArrayDate(value: Date, elementType: string): string {
	if (elementType === "date") return isoDate(value);
	if (
		elementType === "timestamptz" ||
		elementType.includes("with time zone")
	) {
		return iso(value);
	}
	if (elementType.startsWith("timestamp")) return isoTimestamp(value);
	throw new Error(
		`Date cannot be encoded as a Realtime PostgreSQL ${elementType} array element`,
	);
}

function encodeHex(value: Uint8Array): string {
	return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join(
		"",
	);
}
