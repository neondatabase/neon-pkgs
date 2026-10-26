import type { GenerateOptions } from "../options.js";
import { quoteIdentIfNeeded } from "../util/names.js";
import { quoteSqlString } from "../util/sql.js";
import type { ConvexSchema } from "./model.js";
import type { PlannedColumn, PlannedIndex, PlannedTable } from "./plan.js";
import { planSchema } from "./plan.js";

const INDENT = "    ";

export interface DdlResult {
	/** The generated `CREATE TABLE` / `CREATE INDEX` statements. */
	sql: string;
	/** Unsupported features, dropped foreign keys, and skipped indexes. */
	warnings: string[];
}

/**
 * Generate the pre-load Postgres DDL for a Convex schema: `CREATE EXTENSION`
 * lines for the Lakebase extensions the schema needs, then `CREATE TABLE`
 * (including generated `tsvector` columns and `vector(d)` columns), then the
 * foreign-key `ALTER`s and plain btree indexes.
 *
 * Foreign keys are added as separate `ALTER TABLE ... ADD CONSTRAINT` statements
 * emitted after every `CREATE TABLE`, and are `DEFERRABLE INITIALLY DEFERRED`.
 * Deferring to `ALTER` (rather than an inline `REFERENCES`) is what lets a table
 * reference one declared later in the schema, or participate in a reference
 * cycle: an inline `REFERENCES` would fail because the target table does not
 * exist yet when the referencing table is created.
 *
 * Lakebase BM25/ANN indexes and the btree indexes backing their filter fields
 * are **not** here — they are created after the data load by
 * {@link generateIndexDdl}. A schema with no search/vector indexes needs no
 * extensions, so this output is byte-identical to the pre-Lakebase generator.
 * Pure: no I/O.
 */
export function generateDdl(
	schema: ConvexSchema,
	options?: GenerateOptions,
): DdlResult {
	const plan = planSchema(schema, options);
	const blocks: string[] = [];
	const constraints: string[] = [];

	for (const table of plan.tables) {
		blocks.push(createTable(table));
		for (const indexSql of createIndexes(table)) {
			blocks.push(indexSql);
		}
		for (const fkSql of foreignKeyConstraints(table)) {
			constraints.push(fkSql);
		}
	}

	// Extensions first (so a `vector`/`tsvector` column can be created), then the
	// tables, then the foreign keys (after all tables exist, so forward
	// references and cycles are expressible).
	const sections: string[] = [];
	if (plan.extensions.length > 0) {
		sections.push(plan.extensions.join("\n"));
	}
	sections.push(...blocks, ...constraints);

	return {
		sql: `${sections.join("\n\n")}\n`,
		warnings: plan.warnings,
	};
}

/**
 * Generate the post-load index DDL: the btree indexes backing search/vector
 * filter fields, then the Lakebase `lakebase_bm25` indexes over generated
 * `tsvector` columns, then the `lakebase_ann` indexes over `vector` columns.
 *
 * These are built after the bulk load (and run outside any transaction) so BM25
 * gets accurate corpus statistics and ANN a well-tuned layout. Returns an empty
 * string when the schema declares no search or vector indexes. Pure: no I/O.
 */
export function generateIndexDdl(
	schema: ConvexSchema,
	options?: GenerateOptions,
): string {
	const plan = planSchema(schema, options);
	const statements: string[] = [];
	for (const table of plan.tables) {
		for (const index of table.postLoadIndexes) {
			statements.push(postLoadIndex(table, index));
		}
	}
	return statements.length > 0 ? `${statements.join("\n")}\n` : "";
}

function postLoadIndex(table: PlannedTable, index: PlannedIndex): string {
	const name = quoteIdentIfNeeded(index.name);
	const target = quoteIdentIfNeeded(table.pgName);
	if (index.kind === "ann") {
		const column = quoteIdentIfNeeded(index.columns[0]);
		return `CREATE INDEX ${name} ON ${target} USING lakebase_ann (${column} ${index.opclass});`;
	}
	if (index.kind === "bm25") {
		const column = quoteIdentIfNeeded(index.columns[0]);
		return `CREATE INDEX ${name} ON ${target} USING lakebase_bm25 (${column}) WITH (k1 = ${index.k1}, b = ${index.b});`;
	}
	const columns = index.columns
		.map((column) => quoteIdentIfNeeded(column))
		.join(", ");
	return `CREATE INDEX ${name} ON ${target} (${columns});`;
}

function foreignKeyConstraints(table: PlannedTable): string[] {
	const statements: string[] = [];
	for (const column of table.columns) {
		if (column.references === undefined) continue;
		const constraintName = `${table.pgName}_${column.pgName}_fkey`;
		statements.push(
			`ALTER TABLE ${quoteIdentIfNeeded(table.pgName)} ADD CONSTRAINT ${quoteIdentIfNeeded(
				constraintName,
			)} FOREIGN KEY (${quoteIdentIfNeeded(column.pgName)}) REFERENCES ${quoteIdentIfNeeded(
				column.references,
			)} (id) DEFERRABLE INITIALLY DEFERRED;`,
		);
	}
	return statements;
}

function createTable(table: PlannedTable): string {
	const lines = table.columns.map((column) => columnDefinition(column));
	return [
		`CREATE TABLE ${quoteIdentIfNeeded(table.pgName)} (`,
		lines.map((line) => `${INDENT}${line}`).join(",\n"),
		");",
	].join("\n");
}

function columnDefinition(column: PlannedColumn): string {
	// A STORED GENERATED column (a search index's tsvector): Postgres computes it,
	// so it carries no NOT NULL / PRIMARY KEY / CHECK.
	if (column.generatedExpr !== undefined) {
		return `${quoteIdentIfNeeded(column.pgName)} ${column.pgType} GENERATED ALWAYS AS (${column.generatedExpr}) STORED`;
	}

	const parts = [quoteIdentIfNeeded(column.pgName), column.pgType];

	if (column.isPrimaryKey) {
		parts.push("PRIMARY KEY");
	} else if (column.notNull) {
		parts.push("NOT NULL");
	}

	if (column.checkIn !== undefined && column.checkIn.length > 0) {
		const values = column.checkIn.map((v) => quoteSqlString(v)).join(", ");
		parts.push(
			`CHECK (${quoteIdentIfNeeded(column.pgName)} IN (${values}))`,
		);
	}

	return parts.join(" ");
}

function createIndexes(table: PlannedTable): string[] {
	return table.indexes.map((index) => {
		const columns = index.columns
			.map((column) => quoteIdentIfNeeded(column))
			.join(", ");
		return `CREATE INDEX ${quoteIdentIfNeeded(index.name)} ON ${quoteIdentIfNeeded(
			table.pgName,
		)} (${columns});`;
	});
}
