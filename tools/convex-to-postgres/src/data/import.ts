import pg from "pg";
import type { GenerateOptions } from "../options.js";
import { generateDdl, generateIndexDdl } from "../schema/generate-ddl.js";
import type { ConvexSchema } from "../schema/model.js";
import { planSchema } from "../schema/plan.js";
import { quoteIdentIfNeeded } from "../util/names.js";
import { openExportSource } from "./read-export.js";
import { generateStagingDdl, generateStagingDropSql } from "./staging.js";
import { generateTransformSql } from "./transform.js";

/**
 * The minimal `pg`-compatible surface the orchestrator needs. A `pg.Client` or
 * `pg.PoolClient` satisfies it, so callers can supply an existing connection
 * (e.g. one already inside their own transaction) instead of a connection
 * string.
 */
export interface QueryableClient {
	query(
		queryText: string,
		values?: unknown[],
	): Promise<{ rows: unknown[]; rowCount: number | null }>;
}

export interface ImportOptions extends GenerateOptions {
	/** The parsed Convex schema (from {@link loadConvexSchema} or {@link parseExportedSchema}). */
	schema: ConvexSchema;
	/** An extracted `convex export` directory or a `.zip` snapshot. */
	source: string;
	/** An existing connection to load through. Mutually exclusive with `connectionString`. */
	client?: QueryableClient;
	/** A Postgres connection string; a `pg.Client` is created and closed internally. */
	connectionString?: string;
	/** Apply the generated `CREATE TABLE` / `CREATE INDEX` DDL before loading. Defaults to `false`. */
	applySchema?: boolean;
	/** Progress callback. Defaults to a no-op; the core never writes to stdout itself. */
	log?: (message: string) => void;
}

export interface ImportResult {
	/** Rows loaded per Convex table name. */
	tables: Record<string, number>;
	/** Schema-mapping warnings (dropped foreign keys, skipped indexes, ...). */
	warnings: string[];
}

/**
 * Transform a `convex export` snapshot into Postgres and load it.
 *
 * Everything runs in one transaction with foreign keys deferred, so tables load
 * in any order regardless of references or cycles. Each raw JSONL line is loaded
 * through a parameterized `$1::jsonb` insert, so Postgres parses the JSON and no
 * `v.int64` precision is lost. Staging tables are dropped on success.
 */
export async function importConvexExport(
	options: ImportOptions,
): Promise<ImportResult> {
	const log = options.log ?? (() => {});
	const plan = planSchema(options.schema, options);
	const ddl = generateDdl(options.schema, options);
	const source = await openExportSource(options.source);
	const { client, release } = await resolveClient(options);

	const counts: Record<string, number> = {};
	try {
		await client.query("BEGIN");
		if (options.applySchema) {
			log("Applying schema DDL");
			await client.query(ddl.sql);
		}
		// Foreign keys are DEFERRABLE INITIALLY DEFERRED; make the intent explicit.
		await client.query("SET CONSTRAINTS ALL DEFERRED");

		log("Creating staging tables");
		await client.query(generateStagingDdl(options.schema, options));

		for (const table of plan.tables) {
			const insertSql = `INSERT INTO ${quoteIdentIfNeeded(table.stagingName)} (doc) VALUES ($1::jsonb)`;
			let count = 0;
			for await (const line of source.readLines(table.convexName)) {
				await client.query(insertSql, [line]);
				count += 1;
			}
			counts[table.convexName] = count;
			log(`Staged ${count} row(s) for ${table.convexName}`);
		}

		log("Transforming staged documents into typed tables");
		await client.query(generateTransformSql(options.schema, options));

		log("Dropping staging tables");
		await client.query(generateStagingDropSql(options.schema, options));

		await client.query("COMMIT");

		// Lakebase BM25/ANN indexes (and the btrees backing their filter fields)
		// are built after the load, outside the transaction: BM25 then has
		// accurate corpus statistics and ANN a well-tuned layout. VACUUM cannot
		// run inside a transaction, so both run post-COMMIT. Empty for a schema
		// with no search/vector indexes.
		const indexSql = generateIndexDdl(options.schema, options);
		if (indexSql.trim().length > 0) {
			log("Building search and vector indexes");
			await client.query(indexSql);
			log("Running VACUUM ANALYZE");
			await client.query("VACUUM ANALYZE");
		}
	} catch (error) {
		await client.query("ROLLBACK").catch(() => {});
		throw error;
	} finally {
		await release();
	}

	return { tables: counts, warnings: ddl.warnings };
}

async function resolveClient(
	options: ImportOptions,
): Promise<{ client: QueryableClient; release: () => Promise<void> }> {
	if (options.client !== undefined) {
		return { client: options.client, release: async () => {} };
	}
	if (
		options.connectionString === undefined ||
		options.connectionString.length === 0
	) {
		throw new Error(
			"importConvexExport requires either `client` or `connectionString`.",
		);
	}
	const raw = new pg.Client({ connectionString: options.connectionString });
	await raw.connect();
	const client: QueryableClient = {
		async query(text, values) {
			const result = await raw.query(
				text,
				values as unknown[] | undefined,
			);
			return { rows: result.rows, rowCount: result.rowCount };
		},
	};
	return {
		client,
		release: async () => {
			await raw.end();
		},
	};
}
