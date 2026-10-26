import type { GenerateOptions } from "../options.js";
import type { ConvexSchema } from "../schema/model.js";
import type { PlannedTable } from "../schema/plan.js";
import { planSchema } from "../schema/plan.js";
import { quoteIdentIfNeeded } from "../util/names.js";

const INDENT = "    ";

/**
 * Generate the `INSERT INTO <table> (...) SELECT <mapped expressions> FROM
 * _convex_<table>` statements that move staged documents into the typed target
 * tables. The per-column casts (driven by the Convex schema) resolve
 * int64-vs-float64 correctly from jsonb without sniffing the decimal point.
 * Pure: no I/O.
 */
export function generateTransformSql(
	schema: ConvexSchema,
	options?: GenerateOptions,
): string {
	const plan = planSchema(schema, options);
	return `${plan.tables.map((table) => transformStatement(table)).join("\n\n")}\n`;
}

function transformStatement(table: PlannedTable): string {
	// Generated columns (search-index tsvectors) are computed by Postgres, so
	// they appear in neither the INSERT column list nor the SELECT.
	const loaded = table.columns.filter((column) => !column.generated);
	const columns = loaded
		.map((column) => quoteIdentIfNeeded(column.pgName))
		.join(", ");
	const expressions = loaded
		.map((column) => `${INDENT}${column.selectExpr}`)
		.join(",\n");
	return [
		`INSERT INTO ${quoteIdentIfNeeded(table.pgName)} (${columns})`,
		"SELECT",
		expressions,
		`FROM ${quoteIdentIfNeeded(table.stagingName)};`,
	].join("\n");
}
