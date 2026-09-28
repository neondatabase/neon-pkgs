import {
	encodeTextParameter,
	type NeonLiveAdapter,
	type PreparedLiveQueryParameter,
	validateLiveSelectSql,
} from "@neon/live/server";
import {
	assertResultNamesMatchSelection,
	type ConcretePgSelectQuery,
} from "./compat.js";
/**
 * Prepare concrete Drizzle PostgreSQL selects for Neon Live.
 *
 * Drizzle supplies parameterized SQL and driver-ready values. Every parameter
 * uses OID `0`, allowing PostgreSQL to infer its type from SQL context. The
 * proxy returns result metadata when it accepts the subscription.
 *
 * @returns An adapter to pass to `createNeonLive()` on the application backend.
 */
export function drizzleAdapter(): NeonLiveAdapter<ConcretePgSelectQuery> {
	return Object.freeze({
		prepare(query: ConcretePgSelectQuery) {
			const compiled = query.toSQL();
			validateLiveSelectSql(compiled.sql);
			assertResultNamesMatchSelection(query);
			return Object.freeze({
				sql: compiled.sql,
				parameters: Object.freeze(
					compiled.params.map(encodeDrizzleParameter),
				),
			});
		},
	});
}

function encodeDrizzleParameter(value: unknown): PreparedLiveQueryParameter {
	if (
		value === null ||
		typeof value === "string" ||
		typeof value === "number" ||
		typeof value === "boolean" ||
		typeof value === "bigint"
	) {
		return encodeTextParameter(value);
	}
	if (value instanceof Uint8Array) {
		return encodeTextParameter(`\\x${encodeHex(value)}`);
	}
	throw new Error(
		"Drizzle Live produced a parameter that cannot be encoded as PostgreSQL text",
	);
}

function encodeHex(value: Uint8Array): string {
	return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join(
		"",
	);
}
