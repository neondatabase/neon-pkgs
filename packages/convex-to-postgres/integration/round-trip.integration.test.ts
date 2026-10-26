import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
	generateDdl,
	generateSeedSql,
	importConvexExport,
	loadConvexSchema,
} from "../src/index.js";
import { countJsonlLines, FIXTURES, freshSchemaClient } from "./helpers.js";

const SAMPLE = join(FIXTURES, "export-sample");
const SCHEMA_TS = join(SAMPLE, "convex", "schema.ts");
const ZIP = join(SAMPLE, "snapshot.zip");

const EXPECTED_COUNTS = {
	authors: countJsonlLines(join(SAMPLE, "authors", "documents.jsonl")),
	posts: countJsonlLines(join(SAMPLE, "posts", "documents.jsonl")),
	misc: countJsonlLines(join(SAMPLE, "misc", "documents.jsonl")),
};

const AUTHOR_CONVEX_ID = "j572bnfwgshq6ynvrqsmhghec18gt53v";

async function count(
	client: {
		query: (t: string) => Promise<{ rows: unknown[] }>;
	},
	table: string,
): Promise<number> {
	const res = await client.query(`SELECT COUNT(*)::int AS n FROM ${table}`);
	return (res.rows[0] as { n: number }).n;
}

describe("Suite B: full round-trip against the real convex export", () => {
	// --- uuid strategy: one shared import the query tests read from -----------
	describe("uuid strategy", () => {
		let ctx: Awaited<ReturnType<typeof freshSchemaClient>>;
		let result: Awaited<ReturnType<typeof importConvexExport>>;

		beforeAll(async () => {
			const schema = await loadConvexSchema(SCHEMA_TS);
			ctx = await freshSchemaClient("roundtrip_uuid");
			result = await importConvexExport({
				schema,
				source: SAMPLE,
				client: ctx.client,
				applySchema: true,
				idStrategy: "uuid",
			});
		});

		afterAll(async () => {
			await ctx?.cleanup();
		});

		test("reported and actual row counts match the JSONL line counts", async () => {
			expect(result.tables).toEqual(EXPECTED_COUNTS);
			for (const [table, n] of Object.entries(EXPECTED_COUNTS)) {
				expect(await count(ctx.client, table)).toBe(n);
			}
		});

		test("referential integrity: no orphan posts and a committed FK", async () => {
			const orphans = await ctx.client.query(
				"SELECT COUNT(*)::int AS n FROM posts p LEFT JOIN authors a ON p.author_id = a.id WHERE a.id IS NULL",
			);
			expect((orphans.rows[0] as { n: number }).n).toBe(0);

			const fk = await ctx.client.query(
				`SELECT COUNT(*)::int AS n FROM information_schema.table_constraints
				 WHERE table_schema = '${ctx.schema}' AND table_name = 'posts' AND constraint_type = 'FOREIGN KEY'`,
			);
			expect((fk.rows[0] as { n: number }).n).toBeGreaterThanOrEqual(1);

			// The data being present at all proves the single transaction COMMITted.
			expect(await count(ctx.client, "posts")).toBe(
				EXPECTED_COUNTS.posts,
			);
		});

		test("int64 precision survives (queried back as text)", async () => {
			const res = await ctx.client.query(
				"SELECT title, big_number::text AS big FROM posts ORDER BY title",
			);
			const byTitle = Object.fromEntries(
				(res.rows as Array<{ title: string; big: string }>).map((r) => [
					r.title,
					r.big,
				]),
			);
			// 2^53 + 1 is unrepresentable as a JS number; it must come back exact.
			expect(byTitle["First Post"]).toBe("9007199254740993");
			expect(byTitle["Second Post"]).toBe("-1");
		});

		test("bytes decode to the expected buffers, including the empty one", async () => {
			const res = await ctx.client.query(
				"SELECT title, octet_length(data) AS len, encode(data, 'base64') AS b64 FROM posts ORDER BY title",
			);
			const byTitle = Object.fromEntries(
				(
					res.rows as Array<{
						title: string;
						len: number;
						b64: string;
					}>
				).map((r) => [r.title, r]),
			);
			expect(byTitle["First Post"].len).toBe(5);
			expect(byTitle["First Post"].b64).toBe("AAEC/4A=");
			// Empty-buffer row: a real bytea of length 0, not NULL.
			expect(byTitle["Second Post"].len).toBe(0);
			expect(byTitle["Second Post"].b64).toBe("");
		});

		test("_creationTime maps to a timestamptz with sub-second precision", async () => {
			const res = await ctx.client.query(
				`SELECT created_at <> date_trunc('second', created_at) AS subsec,
				        EXTRACT(YEAR FROM created_at)::int AS yr
				 FROM posts`,
			);
			for (const row of res.rows as Array<{
				subsec: boolean;
				yr: number;
			}>) {
				expect(row.subsec).toBe(true);
				expect(row.yr).toBeGreaterThanOrEqual(2020);
				expect(row.yr).toBeLessThanOrEqual(2035);
			}
		});

		test("an absent optional field is NULL; a present one is not", async () => {
			const res = await ctx.client.query(
				"SELECT title, optional_note FROM posts ORDER BY title",
			);
			const byTitle = Object.fromEntries(
				(
					res.rows as Array<{
						title: string;
						optional_note: string | null;
					}>
				).map((r) => [r.title, r.optional_note]),
			);
			// "Second Post" carries optionalNote; "First Post" omits the key.
			expect(byTitle["Second Post"]).toBe("a note here");
			expect(byTitle["First Post"]).toBeNull();
		});

		test("mixed-type union stores as jsonb and optionals round-trip (misc)", async () => {
			const vals = await ctx.client.query("SELECT val FROM misc");
			const valSet = (vals.rows as Array<{ val: unknown }>)
				.map((r) => r.val)
				.sort((a, b) => String(a).localeCompare(String(b)));
			expect(valSet).toEqual(
				[3.5, 7, "a string"].sort((a, b) =>
					String(a).localeCompare(String(b)),
				),
			);

			const maybe = await ctx.client.query(
				"SELECT COUNT(maybe)::int AS present, COUNT(*)::int AS total FROM misc",
			);
			expect((maybe.rows[0] as { present: number }).present).toBe(1);
			expect((maybe.rows[0] as { total: number }).total).toBe(3);

			const blob = await ctx.client.query(
				"SELECT octet_length(blob) AS len FROM misc ORDER BY octet_length(blob) NULLS FIRST",
			);
			const lens = (blob.rows as Array<{ len: number | null }>).map(
				(r) => r.len,
			);
			expect(lens).toEqual([null, 1, 3]);
		});

		test("nested objects land in a jsonb column, preserving Convex float formatting", async () => {
			const res = await ctx.client.query(
				"SELECT title, metadata->'nested'->>'level' AS level FROM posts ORDER BY title",
			);
			const byTitle = Object.fromEntries(
				(res.rows as Array<{ title: string; level: string }>).map(
					(r) => [r.title, r.level],
				),
			);
			// Convex serializes float64 with a decimal point (`3.0`, `0.0`); jsonb
			// preserves that text form, unlike the top-level `double precision`
			// columns which normalize to `3`.
			expect(byTitle["First Post"]).toBe("3.0");
			expect(byTitle["Second Post"]).toBe("0.0");
		});

		test("a string-literal CHECK constraint rejects an out-of-set value", async () => {
			const err = await ctx.client
				.query(
					`INSERT INTO posts
					   (id, created_at, title, count, published, big_number, author_id, metadata, scores, status, kind, data)
					 VALUES
					   (gen_random_uuid(), now(), 'bad', 1, true, 1,
					    (SELECT id FROM authors LIMIT 1), '{}'::jsonb, '[]'::jsonb, 'not-a-status', 1, ''::bytea)`,
				)
				.then(() => null)
				.catch((e: { code?: string }) => e);
			expect(err).not.toBeNull();
			expect((err as { code?: string }).code).toBe("23514"); // check_violation
		});
	});

	// --- text strategy --------------------------------------------------------
	test("text strategy stores ids verbatim and keeps referential integrity", async () => {
		const schema = await loadConvexSchema(SCHEMA_TS);
		const ctx = await freshSchemaClient("roundtrip_text");
		try {
			const result = await importConvexExport({
				schema,
				source: SAMPLE,
				client: ctx.client,
				applySchema: true,
				idStrategy: "text",
			});
			expect(result.tables).toEqual(EXPECTED_COUNTS);

			const author = await ctx.client.query("SELECT id FROM authors");
			expect((author.rows[0] as { id: string }).id).toBe(
				AUTHOR_CONVEX_ID,
			);

			const ref = await ctx.client.query(
				"SELECT author_id FROM posts WHERE title = 'First Post'",
			);
			expect((ref.rows[0] as { author_id: string }).author_id).toBe(
				AUTHOR_CONVEX_ID,
			);

			const orphans = await ctx.client.query(
				"SELECT COUNT(*)::int AS n FROM posts p LEFT JOIN authors a ON p.author_id = a.id WHERE a.id IS NULL",
			);
			expect((orphans.rows[0] as { n: number }).n).toBe(0);
		} finally {
			await ctx.cleanup();
		}
	});

	// --- zip source vs directory source --------------------------------------
	test("the .zip source and the extracted directory produce identical loads", async () => {
		const schema = await loadConvexSchema(SCHEMA_TS);
		const fromDir = await freshSchemaClient("roundtrip_dir");
		const fromZip = await freshSchemaClient("roundtrip_zip");
		try {
			const dirResult = await importConvexExport({
				schema,
				source: SAMPLE,
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

			for (const table of ["authors", "posts", "misc"]) {
				const d = await fromDir.client.query(
					`SELECT id::text AS id FROM ${table} ORDER BY id`,
				);
				const z = await fromZip.client.query(
					`SELECT id::text AS id FROM ${table} ORDER BY id`,
				);
				expect(z.rows).toEqual(d.rows);
			}
		} finally {
			await fromDir.cleanup();
			await fromZip.cleanup();
		}
	});

	// --- generateSeedSql: the `psql -f seed.sql` path -------------------------
	test("generateSeedSql loads the same rows when executed against Postgres", async () => {
		const schema = await loadConvexSchema(SCHEMA_TS);
		const ctx = await freshSchemaClient("roundtrip_seed");
		try {
			// Apply the target-table DDL first (the seed script assumes it exists),
			// then run the generated seed script exactly as `psql -f seed.sql` would.
			await ctx.client.query(generateDdl(schema).sql);
			const seedSql = generateSeedSql(schema, SAMPLE);
			await ctx.client.query(seedSql);

			for (const [table, n] of Object.entries(EXPECTED_COUNTS)) {
				expect(await count(ctx.client, table)).toBe(n);
			}
			const orphans = await ctx.client.query(
				"SELECT COUNT(*)::int AS n FROM posts p LEFT JOIN authors a ON p.author_id = a.id WHERE a.id IS NULL",
			);
			expect((orphans.rows[0] as { n: number }).n).toBe(0);
		} finally {
			await ctx.cleanup();
		}
	});
});
