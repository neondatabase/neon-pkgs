import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { importConvexExport, loadConvexSchema } from "../src/index.js";
import { countJsonlLines, FIXTURES, freshSchemaClient } from "./helpers.js";

const TUTORIAL = join(FIXTURES, "tutorial-export");
const SCHEMA_TS = join(TUTORIAL, "convex", "schema.ts");
const ZIP = join(TUTORIAL, "snapshot.zip");

const EXPECTED_COUNTS = {
	messages: countJsonlLines(join(TUTORIAL, "messages", "documents.jsonl")),
	references: countJsonlLines(
		join(TUTORIAL, "references", "documents.jsonl"),
	),
	u1: countJsonlLines(join(TUTORIAL, "u1", "documents.jsonl")),
	u2: countJsonlLines(join(TUTORIAL, "u2", "documents.jsonl")),
	u3: countJsonlLines(join(TUTORIAL, "u3", "documents.jsonl")),
	u4: countJsonlLines(join(TUTORIAL, "u4", "documents.jsonl")),
};

async function count(
	client: { query: (t: string) => Promise<{ rows: unknown[] }> },
	table: string,
): Promise<number> {
	const res = await client.query(`SELECT COUNT(*)::int AS n FROM ${table}`);
	return (res.rows[0] as { n: number }).n;
}

/**
 * Suite C: a second, recognizable real-app round-trip. The export was produced
 * by deploying the Convex chat tutorial against a local anonymous backend,
 * seeding messages through the app's own `send` mutation, and running
 * `convex export`. It exercises a reserved-word table name (`references`) and
 * four empty `defineTable({})` tables (`u1`..`u4`).
 */
describe("Suite C: tutorial-app round-trip", () => {
	test("messages round-trip cleanly and empty tables stay empty", async () => {
		const schema = await loadConvexSchema(SCHEMA_TS);
		const ctx = await freshSchemaClient("tutorial_uuid");
		try {
			const result = await importConvexExport({
				schema,
				source: TUTORIAL,
				client: ctx.client,
				applySchema: true,
			});
			expect(result.tables).toEqual(EXPECTED_COUNTS);
			// The recognizable chat-app content survives.
			expect(EXPECTED_COUNTS.messages).toBeGreaterThanOrEqual(3);
			for (const [table, n] of Object.entries(EXPECTED_COUNTS)) {
				// `references` is a Postgres reserved word; the generator must quote
				// it, so a plain count against it must also quote it.
				const name = table === "references" ? '"references"' : table;
				expect(await count(ctx.client, name)).toBe(n);
			}

			const author = await ctx.client.query(
				"SELECT author FROM messages ORDER BY created_at LIMIT 1",
			);
			expect((author.rows[0] as { author: string }).author).toBe("Ada");

			// The reserved-word table carries its foreign keys to u1..u4.
			const fks = await ctx.client.query(
				`SELECT COUNT(*)::int AS n FROM information_schema.table_constraints
				 WHERE table_schema = '${ctx.schema}' AND table_name = 'references' AND constraint_type = 'FOREIGN KEY'`,
			);
			expect((fks.rows[0] as { n: number }).n).toBe(4);
		} finally {
			await ctx.cleanup();
		}
	});

	test("the .zip and the extracted directory produce identical counts", async () => {
		const schema = await loadConvexSchema(SCHEMA_TS);
		const fromDir = await freshSchemaClient("tutorial_dir");
		const fromZip = await freshSchemaClient("tutorial_zip");
		try {
			const dirResult = await importConvexExport({
				schema,
				source: TUTORIAL,
				client: fromDir.client,
				applySchema: true,
			});
			const zipResult = await importConvexExport({
				schema,
				source: ZIP,
				client: fromZip.client,
				applySchema: true,
			});
			expect(zipResult.tables).toEqual(dirResult.tables);
			expect(zipResult.tables).toEqual(EXPECTED_COUNTS);
		} finally {
			await fromDir.cleanup();
			await fromZip.cleanup();
		}
	});
});
