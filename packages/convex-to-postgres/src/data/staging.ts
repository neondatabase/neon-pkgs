import type { GenerateOptions } from "../options.js";
import type { ConvexSchema } from "../schema/model.js";
import { planSchema } from "../schema/plan.js";
import { quoteIdentIfNeeded } from "../util/names.js";

/**
 * Generate the per-table jsonb staging tables (`_convex_<table>(doc jsonb NOT
 * NULL)`). Each raw JSONL line is loaded verbatim into its staging table so
 * Postgres (not JavaScript) parses the JSON -- preserving `v.int64` values above
 * 2^53 that `JSON.parse` would round. Pure: no I/O.
 *
 * Pass the same `options` used for {@link generateTransformSql} so the staging
 * table names line up.
 */
export function generateStagingDdl(
	schema: ConvexSchema,
	options?: GenerateOptions,
): string {
	const plan = planSchema(schema, options);
	const statements = plan.tables.map(
		(table) =>
			`CREATE TABLE ${quoteIdentIfNeeded(table.stagingName)} (doc jsonb NOT NULL);`,
	);
	return `${statements.join("\n")}\n`;
}

/**
 * Generate the `DROP TABLE` statements that remove the staging tables created by
 * {@link generateStagingDdl}. Pure: no I/O.
 */
export function generateStagingDropSql(
	schema: ConvexSchema,
	options?: GenerateOptions,
): string {
	const plan = planSchema(schema, options);
	const statements = plan.tables.map(
		(table) => `DROP TABLE ${quoteIdentIfNeeded(table.stagingName)};`,
	);
	return `${statements.join("\n")}\n`;
}
