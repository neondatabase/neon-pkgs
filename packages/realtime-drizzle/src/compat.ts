import { is, SQL } from "drizzle-orm";
import { PgColumn } from "drizzle-orm/pg-core";

/** Exact Drizzle release exercised by the adapter compatibility tests. */
export const SUPPORTED_DRIZZLE_VERSION = "0.45.2";

export interface ConcretePgSelectQuery {
	readonly _: { readonly result: readonly unknown[] };
	toSQL(): { readonly sql: string; readonly params: readonly unknown[] };
}

/**
 * Ensure PostgreSQL's result names preserve the keys in Drizzle's inferred row
 * type. The proxy returns database result names, not Drizzle's client-side
 * selection mapping, so renamed fields must use an explicit SQL alias.
 */
export function assertResultNamesMatchSelection(
	query: ConcretePgSelectQuery,
): void {
	const internal = query as ConcretePgSelectQuery & {
		readonly config?: {
			readonly fields?: Readonly<Record<string, unknown>>;
		};
		getSelectedFields?: () => Readonly<Record<string, unknown>>;
	};
	const fields = internal.config?.fields ?? internal.getSelectedFields?.();
	if (!fields) {
		throw new Error(
			`Drizzle Live requires a PostgreSQL select builder from drizzle-orm ${SUPPORTED_DRIZZLE_VERSION}`,
		);
	}

	const names = new Set<string>();
	for (const [key, field] of Object.entries(fields)) {
		const resultName = postgresResultName(field);
		if (resultName === undefined) {
			throw new Error(
				`Drizzle Live cannot determine the PostgreSQL result name for selected field ${JSON.stringify(key)}; use an explicit SQL alias`,
			);
		}
		if (resultName !== key) {
			throw new Error(
				`Drizzle Live selected field ${JSON.stringify(key)} is returned by PostgreSQL as ${JSON.stringify(resultName)}; use an explicit SQL alias matching the selection key`,
			);
		}
		if (names.has(resultName)) {
			throw new Error(
				"Drizzle Live selections must have unique PostgreSQL result names",
			);
		}
		names.add(resultName);
	}
	if (names.size === 0) {
		throw new Error("Drizzle Live queries must select at least one field");
	}
}

function postgresResultName(field: unknown): string | undefined {
	if (is(field, PgColumn)) return field.name;
	if (is(field, SQL.Aliased)) return field.fieldAlias;
	return undefined;
}
