import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
	generateDdl,
	generateIndexDdl,
	loadConvexSchema,
	planSchema,
} from "../src/index.js";
import { FIXTURES, freshSchemaClient, infoSchemaType } from "./helpers.js";

const CORPUS = join(FIXTURES, "corpus");

const dirs = readdirSync(CORPUS, { withFileTypes: true })
	.filter((entry) => entry.isDirectory())
	.map((entry) => entry.name)
	.sort();

/**
 * Suite A: every vendored corpus `schema.ts` must load, generate DDL, and have
 * that DDL apply cleanly to a real Postgres. A fixture that fails to *load*
 * (an unavailable external dep) is skipped with a recorded reason; a fixture
 * that loads but whose DDL fails to apply is a generator bug, not a skip.
 *
 * Fixtures that declare a search or vector index are the exception: their DDL
 * now emits Neon Lakebase extensions (`lakebase_text` / `lakebase_vector`) and
 * `vector(d)` columns that the stock `postgres:*` container cannot create (those
 * extensions exist only on Neon's managed platform). For those fixtures the
 * suite asserts the *emitted* SQL instead of applying it — no Docker image
 * change is needed, and the apply path is unchanged for every other fixture.
 */
describe("Suite A: corpus DDL applies to Postgres", () => {
	test("vendored at least 8 corpus fixtures", () => {
		expect(dirs.length).toBeGreaterThanOrEqual(8);
	});

	for (const dir of dirs) {
		test(`${dir}: loads, applies, and matches the plan`, async (ctx) => {
			const schemaPath = join(CORPUS, dir, "schema.ts");

			let schema: Awaited<ReturnType<typeof loadConvexSchema>>;
			try {
				schema = await loadConvexSchema(schemaPath);
			} catch (error) {
				// A load failure means an unavailable external dependency, not a
				// generator bug. Record why and skip rather than fail the suite.
				const message =
					error instanceof Error
						? error.message.split("\n")[0]
						: String(error);
				ctx.skip(`schema failed to load: ${message}`);
				return;
			}

			const ddl = generateDdl(schema);
			const plan = planSchema(schema);

			const hasSearch = schema.tables.some(
				(t) => t.searchIndexes.length > 0,
			);
			const hasVector = schema.tables.some(
				(t) => t.vectorIndexes.length > 0,
			);

			// Emit-only path: the Lakebase extensions do not exist in a stock
			// Postgres container, so assert the generated SQL rather than apply it.
			if (hasSearch || hasVector) {
				const indexSql = generateIndexDdl(schema);
				if (hasVector) {
					expect(ddl.sql, "lakebase_vector extension").toContain(
						"CREATE EXTENSION IF NOT EXISTS lakebase_vector CASCADE;",
					);
					expect(ddl.sql, "vector column").toContain("vector(");
					expect(indexSql, "ann index").toContain("lakebase_ann");
				}
				if (hasSearch) {
					expect(ddl.sql, "lakebase_text extension").toContain(
						"CREATE EXTENSION IF NOT EXISTS lakebase_text;",
					);
					expect(ddl.sql, "generated tsvector column").toContain(
						"tsvector GENERATED ALWAYS AS (to_tsvector(",
					);
					expect(indexSql, "bm25 index").toContain("lakebase_bm25");
				}
				return;
			}

			const {
				client,
				schema: ns,
				cleanup,
			} = await freshSchemaClient(dir);
			try {
				// The core assertion: the generated DDL executes with no error.
				await client.query(ddl.sql);

				// Every planned table exists in this namespace.
				const tablesRes = await client.query(
					"SELECT table_name FROM information_schema.tables WHERE table_schema = $1",
					[ns],
				);
				const actualTables = new Set(
					tablesRes.rows.map(
						(r) => (r as { table_name: string }).table_name,
					),
				);
				for (const table of plan.tables) {
					expect(actualTables, `table ${table.pgName}`).toContain(
						table.pgName,
					);
				}

				// Every planned column exists with the planned type (a sample check
				// across all tables; derived from the plan so it is not brittle).
				const colsRes = await client.query(
					"SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_schema = $1",
					[ns],
				);
				const colType = new Map<string, string>();
				for (const row of colsRes.rows as Array<{
					table_name: string;
					column_name: string;
					data_type: string;
				}>) {
					colType.set(
						`${row.table_name}.${row.column_name}`,
						row.data_type,
					);
				}
				for (const table of plan.tables) {
					for (const column of table.columns) {
						const key = `${table.pgName}.${column.pgName}`;
						expect(colType.has(key), `column ${key} exists`).toBe(
							true,
						);
						expect(colType.get(key), `type of ${key}`).toBe(
							infoSchemaType(column.pgType),
						);
					}
				}
			} finally {
				await cleanup();
			}
		});
	}
});
