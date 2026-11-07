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
 * that DDL apply cleanly to a real Postgres. A load or apply failure fails the
 * test.
 *
 * Search and vector indexes are the exception. By default a search index is a
 * Neon Lakebase BM25 index, and a vector index a `lakebase_ann` index over a
 * `vector(d)` column: the `lakebase_text` / `lakebase_vector` extensions behind
 * them exist only on Neon's managed platform, so the stock `postgres:*`
 * container cannot create them. For those, the suite asserts the *emitted* SQL.
 * The suite applies everything else with `searchIndex: "gin"`, whose stock GIN
 * index runs anywhere, so a fixture with only search indexes still applies end
 * to end, post-load indexes included.
 */
describe("Suite A: corpus DDL applies to Postgres", () => {
	test("vendored at least 8 corpus fixtures", () => {
		expect(dirs.length).toBeGreaterThanOrEqual(8);
	});

	for (const dir of dirs) {
		test(`${dir}: loads, applies, and matches the plan`, async () => {
			const schema = await loadConvexSchema(
				join(CORPUS, dir, "schema.ts"),
			);

			// Applied with the stock GIN search index; see the suite comment.
			const gin = { searchIndex: "gin" } as const;
			const ddl = generateDdl(schema, gin);
			const plan = planSchema(schema, gin);
			const indexSql = generateIndexDdl(schema, gin);

			const hasSearch = schema.tables.some(
				(t) => t.searchIndexes.length > 0,
			);
			const hasVector = schema.tables.some(
				(t) => t.vectorIndexes.length > 0,
			);

			if (hasSearch) {
				// Default: Lakebase BM25. Emit-only, because the extension isn't
				// in the stock container.
				const defaultDdl = generateDdl(schema).sql;
				expect(defaultDdl, "lakebase_text extension").toContain(
					"CREATE EXTENSION IF NOT EXISTS lakebase_text;",
				);
				expect(defaultDdl, "generated tsvector column").toContain(
					"tsvector GENERATED ALWAYS AS (to_tsvector(",
				);
				expect(generateIndexDdl(schema), "bm25 index").toContain(
					"lakebase_bm25",
				);
				// With gin: the same column, a GIN index, and no extension.
				expect(ddl.sql, "no lakebase_text with gin").not.toContain(
					"lakebase_text",
				);
				expect(indexSql, "gin index").toContain("USING gin (");
			}

			// Emit-only path: the Lakebase vector extension does not exist in a
			// stock Postgres container, so assert the generated SQL rather than
			// apply it.
			if (hasVector) {
				expect(ddl.sql, "lakebase_vector extension").toContain(
					"CREATE EXTENSION IF NOT EXISTS lakebase_vector CASCADE;",
				);
				expect(ddl.sql, "vector column").toContain("vector(");
				expect(indexSql, "ann index").toContain("lakebase_ann");
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

				// The post-load indexes (GIN search indexes and their filter
				// btrees) apply too, and every one of them exists afterwards.
				if (indexSql.length > 0) {
					await client.query(indexSql);
					const indexesRes = await client.query(
						"SELECT indexname FROM pg_indexes WHERE schemaname = $1",
						[ns],
					);
					const actualIndexes = new Set(
						indexesRes.rows.map(
							(r) => (r as { indexname: string }).indexname,
						),
					);
					for (const table of plan.tables) {
						for (const index of table.postLoadIndexes) {
							expect(
								actualIndexes,
								`index ${index.name}`,
							).toContain(index.name);
						}
					}
				}
			} finally {
				await cleanup();
			}
		});
	}
});
