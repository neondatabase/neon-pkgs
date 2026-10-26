import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { GenerateOptions } from "../options.js";
import { generateIndexDdl } from "../schema/generate-ddl.js";
import type { ConvexSchema } from "../schema/model.js";
import { planSchema } from "../schema/plan.js";
import { quoteIdentIfNeeded } from "../util/names.js";
import { quoteSqlString } from "../util/sql.js";
import { generateStagingDdl, generateStagingDropSql } from "./staging.js";
import { generateTransformSql } from "./transform.js";

/**
 * Build a single self-contained SQL script that seeds Postgres from an extracted
 * `convex export` directory. The script stages each table's raw JSONL as jsonb,
 * runs the typed transform, and drops the staging tables -- all inside one
 * transaction with deferred foreign keys. Run it with `psql -f seed.sql` once
 * the target tables exist (apply {@link generateDdl}'s output first).
 *
 * Raw JSONL lines are embedded verbatim as jsonb literals and never parsed in
 * JavaScript, so a `v.int64` value above 2^53 survives exactly. `exportDir` is
 * an extracted export directory (use `importConvexExport` to load a `.zip`).
 */
export function generateSeedSql(
	schema: ConvexSchema,
	exportDir: string,
	options?: GenerateOptions,
): string {
	const plan = planSchema(schema, options);
	const parts: string[] = [
		"BEGIN;",
		"",
		"-- Staging tables (raw Convex documents as jsonb)",
		generateStagingDdl(schema, options).trimEnd(),
		"",
	];

	for (const table of plan.tables) {
		const inserts = stagingInserts(
			exportDir,
			table.convexName,
			table.stagingName,
		);
		if (inserts.length === 0) continue;
		parts.push(`-- Data for ${table.convexName}`, ...inserts, "");
	}

	parts.push(
		"-- Transform staged documents into the typed tables",
		generateTransformSql(schema, options).trimEnd(),
		"",
		"-- Remove staging tables",
		generateStagingDropSql(schema, options).trimEnd(),
		"",
		"COMMIT;",
		"",
	);

	// Lakebase BM25/ANN indexes (and the btrees backing their filter fields) are
	// built AFTER the load, outside the transaction. Indexes-after-load gives BM25
	// accurate corpus statistics and ANN a well-tuned layout; building them before
	// the load works too, just less well tuned. VACUUM cannot run in a transaction.
	const indexSql = generateIndexDdl(schema, options).trimEnd();
	if (indexSql.length > 0) {
		parts.push(
			"-- Build search/vector indexes after the load (outside the transaction)",
			indexSql,
			"",
			"VACUUM ANALYZE;",
			"",
		);
	}

	return parts.join("\n");
}

function stagingInserts(
	exportDir: string,
	convexTable: string,
	stagingName: string,
): string[] {
	const path = join(exportDir, convexTable, "documents.jsonl");
	if (!existsSync(path)) return [];
	const target = quoteIdentIfNeeded(stagingName);
	const lines = readFileSync(path, "utf8").split(/\r?\n/);
	const inserts: string[] = [];
	for (const line of lines) {
		if (line.trim().length === 0) continue;
		// The raw line is embedded verbatim; Postgres parses the jsonb, so numeric
		// precision (int64 vs float64) is never lost to a JavaScript JSON.parse.
		inserts.push(
			`INSERT INTO ${target} (doc) VALUES (${quoteSqlString(line)}::jsonb);`,
		);
	}
	return inserts;
}
