import { rmSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { importConvexExport, parseExportedSchema } from "../src/index.js";
import { field, schema, table, v } from "../src/test-fixtures.js";
import { freshSchemaClient, writeExportDir } from "./helpers.js";

/**
 * Suite E: a Convex `searchIndex` imported with `searchIndex: "gin"`, end to
 * end on stock Postgres. GIN needs no extension, so unlike the default BM25
 * index it applies to the plain container, and the search query the README
 * documents for GIN runs against the loaded rows.
 */
const exported = schema([
	table({
		name: "events",
		fields: {
			calendarId: field(v.string()),
			title: field(v.string()),
		},
		searchIndexes: [
			{
				indexDescriptor: "search_title",
				searchField: "title",
				filterFields: ["calendarId"],
			},
		],
	}),
]);

const TITLES = [
	"Team standup",
	"Standups retro",
	"Design review",
	"Lunch with the design team",
	"Quarterly planning",
];

const SEARCH = `SELECT title, ts_rank(title_tsv, websearch_to_tsquery('english', $1)) AS rank
FROM events
WHERE title_tsv @@ websearch_to_tsquery('english', $1)
ORDER BY rank DESC, title`;

describe("Suite E: GIN search index, end to end", () => {
	let ctx: Awaited<ReturnType<typeof freshSchemaClient>>;
	let exportDir: string;
	let warnings: string[];

	beforeAll(async () => {
		exportDir = writeExportDir({
			events: TITLES.map((title, i) => ({
				_id: `event${i}`,
				_creationTime: 1792787860912.5 + i,
				calendarId: i < 3 ? "work" : "home",
				title,
			})),
		});
		ctx = await freshSchemaClient("search_gin");
		const result = await importConvexExport({
			schema: parseExportedSchema(exported),
			source: exportDir,
			client: ctx.client,
			applySchema: true,
			searchIndex: "gin",
		});
		warnings = result.warnings;
	});

	afterAll(async () => {
		await ctx?.cleanup();
		if (exportDir !== undefined) {
			rmSync(exportDir, { recursive: true, force: true });
		}
	});

	test("imports with no warnings and no Lakebase extension", async () => {
		expect(warnings).toEqual([]);
		const ext = await ctx.client.query(
			"SELECT count(*)::int AS n FROM pg_extension WHERE extname LIKE 'lakebase%'",
		);
		expect((ext.rows[0] as { n: number }).n).toBe(0);
	});

	test("builds a GIN index over the generated tsvector, plus the filter btree", async () => {
		const res = await ctx.client.query(
			"SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = $1 AND tablename = 'events' ORDER BY indexname",
			[ctx.schema],
		);
		const defs = Object.fromEntries(
			(res.rows as Array<{ indexname: string; indexdef: string }>).map(
				(r) => [r.indexname, r.indexdef],
			),
		);
		expect(defs.events_title_gin).toContain("USING gin (title_tsv)");
		expect(defs.events_calendar_id).toContain("btree (calendar_id)");
		expect(Object.values(defs).join("\n")).not.toContain("lakebase");
	});

	test("the documented @@ / websearch_to_tsquery / ts_rank query finds and ranks rows", async () => {
		const standup = await ctx.client.query(SEARCH, ["standup"]);
		expect(
			(standup.rows as Array<{ title: string }>).map((r) => r.title),
		).toEqual(["Standups retro", "Team standup"]);
		for (const row of standup.rows as Array<{ rank: number }>) {
			expect(row.rank).toBeGreaterThan(0);
		}

		// websearch syntax: a quoted phrase and a negated term.
		const phrase = await ctx.client.query(SEARCH, [
			'"design review" -lunch',
		]);
		expect(
			(phrase.rows as Array<{ title: string }>).map((r) => r.title),
		).toEqual(["Design review"]);
	});

	test("the query can use the GIN index", async () => {
		await ctx.client.query("SET enable_seqscan = off");
		try {
			const plan = await ctx.client.query(`EXPLAIN ${SEARCH}`, [
				"standup",
			]);
			const text = (plan.rows as Array<{ "QUERY PLAN": string }>)
				.map((r) => r["QUERY PLAN"])
				.join("\n");
			expect(text).toContain("events_title_gin");
		} finally {
			await ctx.client.query("RESET enable_seqscan");
		}
	});
});
