import { parse as parsePostgresArray } from "postgres-array";
import {
	parsePostgresDate,
	parsePostgresJsDate,
	parsePostgresTimestamp,
	parsePostgresTimestampWithTimeZone,
} from "./date.js";
import { pgTypeOids, postgresArrayTypes } from "./oids.js";

/** A parser for a PostgreSQL value transported with the `pg_text` codec. */
export type PostgreSQLTextParser<Value = unknown> = (value: string) => Value;

/** A parser for PostgreSQL `bytea`, transported as decoded bytes. */
export type PostgreSQLBytesParser<Value = unknown> = (
	value: Uint8Array,
) => Value;

/** Parser input selected by the fixed Realtime protocol v1 OID/codec mapping. */
export type PostgreSQLParserForOid<Oid extends number> =
	Oid extends typeof pgTypeOids.bytea
		? PostgreSQLBytesParser
		: PostgreSQLTextParser;

type BuiltInOid = (typeof pgTypeOids)[keyof typeof pgTypeOids];
type BuiltInParsers = {
	readonly [Oid in BuiltInOid]?: PostgreSQLParserForOid<Oid>;
};

/** A sparse collection of result parsers keyed by PostgreSQL type OID. */
export type PostgreSQLParsers = Readonly<
	Record<number, PostgreSQLTextParser | PostgreSQLBytesParser> &
		BuiltInParsers
>;

/**
 * Define an OID-keyed parser preset with contextual input types.
 *
 * OID `pgTypeOids.bytea` receives `Uint8Array`; every other OID receives
 * PostgreSQL text. The returned object is a frozen snapshot of the input.
 */
export function defineParsers(parsers: BuiltInParsers): PostgreSQLParsers;
export function defineParsers(
	parsers: Readonly<Record<number, PostgreSQLTextParser>>,
): PostgreSQLParsers;
export function defineParsers(
	parsers: Readonly<Record<number, unknown>>,
): PostgreSQLParsers {
	return Object.freeze({ ...parsers }) as PostgreSQLParsers;
}

/**
 * Core result parsers matching familiar node-postgres/Neon Serverless values.
 *
 * Less-common and unknown OIDs are intentionally absent and fall back to their
 * exact PostgreSQL text. Known built-in array OIDs are decoded recursively by
 * the client using the active parser for their element OID.
 */
export const nodePostgresParsers: PostgreSQLParsers = defineParsers({
	[pgTypeOids.bool]: parseBoolean,
	[pgTypeOids.bytea]: (value) => value,
	[pgTypeOids.int2]: (value) => parseInteger(value, -32_768, 32_767, "int2"),
	[pgTypeOids.int4]: (value) =>
		parseInteger(value, -2_147_483_648, 2_147_483_647, "int4"),
	[pgTypeOids.int8]: parseInt8,
	[pgTypeOids.oid]: (value) => parseInteger(value, 0, 4_294_967_295, "oid"),
	[pgTypeOids.float4]: (value) => parseFloatValue(value, "float4"),
	[pgTypeOids.float8]: (value) => parseFloatValue(value, "float8"),
	[pgTypeOids.numeric]: parseNumeric,
	[pgTypeOids.json]: parseJson,
	[pgTypeOids.jsonb]: parseJson,
	[pgTypeOids.date]: parsePostgresDate,
	[pgTypeOids.timestamp]: parsePostgresTimestamp,
	[pgTypeOids.timestamptz]: parsePostgresTimestampWithTimeZone,
});

/**
 * Parsers that differ from the core defaults when matching Postgres.js.
 * Spread this partial preset into the client's `parsers` option.
 */
export const postgresJsParsers: PostgreSQLParsers = defineParsers({
	[pgTypeOids.date]: parsePostgresJsDate,
});

export interface PostgreSQLParserRegistry {
	parse(oid: number, value: string | Uint8Array): unknown;
}

/** Snapshot and validate the parser configuration supplied to one client. */
export function createParserRegistry(
	overrides: PostgreSQLParsers | undefined,
): PostgreSQLParserRegistry {
	const parsers = new Map<
		number,
		PostgreSQLTextParser | PostgreSQLBytesParser
	>();
	const overridden = new Set<number>();
	addParsers(parsers, nodePostgresParsers, undefined);
	addParsers(parsers, overrides, overridden);

	return Object.freeze({
		parse(oid: number, value: string | Uint8Array): unknown {
			const arrayType = postgresArrayTypes.get(oid);
			if (
				arrayType &&
				arrayType.delimiter === "," &&
				!overridden.has(oid)
			) {
				if (typeof value !== "string") {
					throw new Error("PostgreSQL arrays require pg_text input");
				}
				return parsePostgresArray(value, (element) => {
					if (arrayType.elementOid === pgTypeOids.bytea) {
						return parseWith(
							parsers,
							arrayType.elementOid,
							decodeBytea(element),
						);
					}
					return parseWith(parsers, arrayType.elementOid, element);
				});
			}
			return parseWith(parsers, oid, value);
		},
	});
}

function addParsers(
	target: Map<number, PostgreSQLTextParser | PostgreSQLBytesParser>,
	source: PostgreSQLParsers | undefined,
	overridden: Set<number> | undefined,
): void {
	if (source === undefined) return;
	if (
		source === null ||
		typeof source !== "object" ||
		Array.isArray(source)
	) {
		throw new TypeError("Realtime parsers must be an OID-keyed object");
	}
	for (const [key, parser] of Object.entries(source)) {
		if (!/^[1-9][0-9]*$/.test(key)) {
			throw new TypeError(
				`Invalid PostgreSQL parser OID ${JSON.stringify(key)}`,
			);
		}
		const oid = Number(key);
		if (!Number.isSafeInteger(oid) || oid > 4_294_967_295) {
			throw new TypeError(
				`Invalid PostgreSQL parser OID ${JSON.stringify(key)}`,
			);
		}
		if (typeof parser !== "function") {
			throw new TypeError(
				`PostgreSQL parser for OID ${oid} must be a function`,
			);
		}
		target.set(oid, parser);
		overridden?.add(oid);
	}
}

function parseWith(
	parsers: ReadonlyMap<number, PostgreSQLTextParser | PostgreSQLBytesParser>,
	oid: number,
	value: string | Uint8Array,
): unknown {
	const parser = parsers.get(oid);
	if (!parser) return value;
	return parser(value as never);
}

function parseBoolean(value: string): boolean {
	if (value === "t") return true;
	if (value === "f") return false;
	throw new Error("Invalid PostgreSQL bool value");
}

function parseInteger(
	value: string,
	minimum: number,
	maximum: number,
	type: string,
): number {
	if (!/^-?(?:0|[1-9][0-9]*)$/.test(value)) {
		throw new Error(`Invalid PostgreSQL ${type} value`);
	}
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
		throw new Error(`Invalid PostgreSQL ${type} value`);
	}
	return parsed;
}

function parseInt8(value: string): string {
	if (!/^-?(?:0|[1-9][0-9]*)$/.test(value)) {
		throw new Error("Invalid PostgreSQL int8 value");
	}
	const parsed = BigInt(value);
	if (
		parsed < -9_223_372_036_854_775_808n ||
		parsed > 9_223_372_036_854_775_807n
	) {
		throw new Error("Invalid PostgreSQL int8 value");
	}
	return value;
}

function parseFloatValue(value: string, type: string): number {
	if (value === "NaN") return Number.NaN;
	if (value === "Infinity") return Infinity;
	if (value === "-Infinity") return -Infinity;
	if (!/^[+-]?(?:(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)$/.test(value)) {
		throw new Error(`Invalid PostgreSQL ${type} value`);
	}
	const parsed = Number(value);
	if (!Number.isFinite(parsed))
		throw new Error(`Invalid PostgreSQL ${type} value`);
	return parsed;
}

function parseNumeric(value: string): string {
	if (
		value !== "NaN" &&
		value !== "Infinity" &&
		value !== "-Infinity" &&
		!/^[+-]?(?:(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)$/.test(value)
	) {
		throw new Error("Invalid PostgreSQL numeric value");
	}
	return value;
}

function parseJson(value: string): unknown {
	return JSON.parse(value);
}

function decodeBytea(value: string): Uint8Array {
	if (!/^\\x(?:[0-9a-fA-F]{2})*$/.test(value)) {
		throw new Error("Invalid PostgreSQL bytea value");
	}
	const bytes = new Uint8Array((value.length - 2) / 2);
	for (let index = 0; index < bytes.length; index += 1) {
		bytes[index] = Number.parseInt(
			value.slice(2 + index * 2, 4 + index * 2),
			16,
		);
	}
	return bytes;
}
