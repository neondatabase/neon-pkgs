import { createHash } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { importConvexExport, parseExportedSchema } from "../src/index.js";
import { field, schema, table, v } from "../src/test-fixtures.js";
import { freshSchemaClient, writeExportDir } from "./helpers.js";

/**
 * Suite F: `v.id()` values nested in jsonb columns. Under the uuid strategy
 * each one must hash to the same uuid as the row it points at, so a join
 * through the jsonb finds every target; under the text strategy they stay
 * verbatim and the join still works.
 */
const exported = schema([
	table({ name: "players", fields: { name: field(v.string()) } }),
	table({ name: "cars", fields: { name: field(v.string()) } }),
	table({
		name: "races",
		fields: {
			hostPlayerId: field(v.id("players")),
			// The shape a real app hit: an array of ids.
			participants: field(v.array(v.id("players"))),
			results: field(
				v.array(
					v.object({
						playerId: field(v.id("players")),
						carId: field(v.id("cars")),
						position: field(v.number()),
						bestLapMs: field(v.number(), true),
					}),
				),
				true,
			),
			lapsByPlayer: field(v.record(v.id("players"), v.number())),
			carByLabel: field(v.record(v.string(), v.id("cars"))),
			podium: field(v.array(v.union(v.id("players"), v.null()))),
			teams: field(v.array(v.array(v.id("players")))),
			winner: field(
				v.union(
					v.object({
						kind: field(v.literal("player")),
						ref: field(v.id("players")),
					}),
					v.object({ kind: field(v.literal("none")) }),
				),
			),
			// Can't be told apart from free text, so it's left alone with a warning.
			ref: field(v.union(v.id("players"), v.string())),
		},
	}),
]);

const P = [
	"k171a1ice000000000000000000000p0",
	"k171b0b00000000000000000000000p1",
	"k171ca401000000000000000000000p2",
];
const C = [
	"j57red0000000000000000000000000c0",
	"j57b1ue000000000000000000000000c1",
];

/** The uuid the tool derives from a Convex id: `md5(id)::uuid::text`. */
function uuid(id: string): string {
	const h = createHash("md5").update(id).digest("hex");
	return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const t = 1792787860912.5;
const docs = {
	players: P.map((_id, i) => ({ _id, _creationTime: t + i, name: `p${i}` })),
	cars: C.map((_id, i) => ({ _id, _creationTime: t + i, name: `c${i}` })),
	races: [
		{
			_id: "race1",
			_creationTime: t,
			hostPlayerId: P[0],
			participants: [P[0], P[1], P[2]],
			results: [
				{ playerId: P[0], carId: C[0], position: 1, bestLapMs: 1000.5 },
				{ playerId: P[1], carId: C[1], position: 2 },
			],
			lapsByPlayer: { [P[0]]: 3, [P[1]]: 2 },
			carByLabel: { red: C[0], blue: C[1] },
			podium: [P[0], null, P[2]],
			teams: [[P[0], P[1]], [P[2]]],
			winner: { kind: "player", ref: P[0] },
			ref: "free text",
		},
		{
			_id: "race2",
			_creationTime: t + 1,
			hostPlayerId: P[1],
			participants: [P[1], P[2]],
			lapsByPlayer: {},
			carByLabel: {},
			podium: [],
			teams: [],
			winner: { kind: "none" },
			ref: P[2],
		},
	],
};

const PARTICIPANT_COUNT = docs.races.reduce(
	(n, race) => n + race.participants.length,
	0,
);

const JOIN = `SELECT count(*)::int AS n FROM races r, jsonb_array_elements_text(r.participants) e(v) JOIN players p ON p.id::text = e.v`;

type Row = Record<string, unknown>;

describe("Suite F: nested ids", () => {
	let exportDir: string;

	beforeAll(() => {
		exportDir = writeExportDir(docs);
	});

	afterAll(() => {
		if (exportDir !== undefined) {
			rmSync(exportDir, { recursive: true, force: true });
		}
	});

	describe("uuid strategy (default)", () => {
		let ctx: Awaited<ReturnType<typeof freshSchemaClient>>;
		let warnings: string[];
		let race1: Row;
		let race2: Row;

		beforeAll(async () => {
			ctx = await freshSchemaClient("nested_uuid");
			const result = await importConvexExport({
				schema: parseExportedSchema(exported),
				source: exportDir,
				client: ctx.client,
				applySchema: true,
			});
			warnings = result.warnings;
			const rows = await ctx.client.query(
				"SELECT * FROM races ORDER BY created_at",
			);
			[race1, race2] = rows.rows as Row[];
		});

		afterAll(async () => {
			await ctx?.cleanup();
		});

		test("every array element joins to players.id", async () => {
			const res = await ctx.client.query(JOIN);
			expect((res.rows[0] as { n: number }).n).toBe(PARTICIPANT_COUNT);
		});

		test("array order is kept, and matches the top-level reference's hash", () => {
			expect(race1.participants).toEqual(P.map(uuid));
			expect(race2.participants).toEqual([uuid(P[1]), uuid(P[2])]);
			expect(race1.host_player_id).toBe(
				(race1.participants as string[])[0],
			);
		});

		test("objects in an array: id keys convert, other keys and absent keys don't change", () => {
			expect(race1.results).toEqual([
				{
					playerId: uuid(P[0]),
					carId: uuid(C[0]),
					position: 1,
					bestLapMs: 1000.5,
				},
				{ playerId: uuid(P[1]), carId: uuid(C[1]), position: 2 },
			]);
			// An absent optional field stays NULL.
			expect(race2.results).toBeNull();
		});

		test("record keys and record values that are ids convert", () => {
			expect(race1.laps_by_player).toEqual({
				[uuid(P[0])]: 3,
				[uuid(P[1])]: 2,
			});
			expect(race1.car_by_label).toEqual({
				red: uuid(C[0]),
				blue: uuid(C[1]),
			});
			expect(race2.laps_by_player).toEqual({});
			expect(race2.car_by_label).toEqual({});
		});

		test("nulls, nested arrays and empty arrays", () => {
			expect(race1.podium).toEqual([uuid(P[0]), null, uuid(P[2])]);
			expect(race1.teams).toEqual([
				[uuid(P[0]), uuid(P[1])],
				[uuid(P[2])],
			]);
			expect(race2.podium).toEqual([]);
			expect(race2.teams).toEqual([]);
		});

		test("a discriminated union of objects converts its id key", () => {
			expect(race1.winner).toEqual({ kind: "player", ref: uuid(P[0]) });
			expect(race2.winner).toEqual({ kind: "none" });
		});

		test("a union of v.id() and v.string() is left alone, with a warning", () => {
			expect(race1.ref).toBe("free text");
			expect(race2.ref).toBe(P[2]);
			expect(warnings).toContain(
				`table "races": can't convert the ids in "races.ref" (a union mixes v.id() with other strings), so they stay Convex id strings in the jsonb and won't match the uuid ids. Convert them by hand, or use --id-strategy text.`,
			);
		});

		test("nested results join to both players and cars", async () => {
			const res = await ctx.client.query(
				`SELECT count(*)::int AS n FROM races r, jsonb_array_elements(r.results) e(x)
				 JOIN players p ON p.id::text = e.x->>'playerId'
				 JOIN cars c ON c.id::text = e.x->>'carId'`,
			);
			expect((res.rows[0] as { n: number }).n).toBe(2);
		});
	});

	describe("text strategy", () => {
		let ctx: Awaited<ReturnType<typeof freshSchemaClient>>;

		beforeAll(async () => {
			ctx = await freshSchemaClient("nested_text");
			await importConvexExport({
				schema: parseExportedSchema(exported),
				source: exportDir,
				client: ctx.client,
				applySchema: true,
				idStrategy: "text",
			});
		});

		afterAll(async () => {
			await ctx?.cleanup();
		});

		test("nested ids stay verbatim and still join to the text ids", async () => {
			const rows = await ctx.client.query(
				"SELECT participants, laps_by_player FROM races ORDER BY created_at",
			);
			const [race1] = rows.rows as Row[];
			expect(race1.participants).toEqual(P);
			expect(race1.laps_by_player).toEqual({ [P[0]]: 3, [P[1]]: 2 });
			const res = await ctx.client.query(JOIN);
			expect((res.rows[0] as { n: number }).n).toBe(PARTICIPANT_COUNT);
		});
	});

	describe("edge cases (uuid strategy)", () => {
		const edgeSchema = schema([
			table({ name: "players", fields: { name: field(v.string()) } }),
			table({
				name: "edges",
				fields: {
					quoted: field(
						v.object({
							"it's": field(v.id("players")),
							"back\\slash": field(v.id("players")),
							"": field(v.id("players")),
						}),
					),
					labels: field(v.record(v.string(), v.id("players"))),
					tagged: field(
						v.array(v.union(v.id("players"), v.literal("o'clock"))),
					),
					optionalList: field(v.array(v.id("players")), true),
					optionalObject: field(
						v.object({ p: field(v.id("players")) }),
						true,
					),
					stats: field(
						v.array(
							v.object({
								playerId: field(v.id("players")),
								speed: field(v.number()),
							}),
						),
					),
					long: field(v.array(v.id("players"))),
					blob: field(
						v.union(
							v.record(v.id("players"), v.number()),
							v.bytes(),
						),
					),
					owner: field(
						v.union(
							v.object({
								kind: field(v.literal("u")),
								ref: field(v.id("players")),
							}),
							v.object({
								kind: field(v.literal("s")),
								ref: field(v.string()),
							}),
						),
					),
					byOwner: field(
						v.record(
							v.union(v.id("players"), v.literal("system")),
							v.number(),
						),
					),
					proto: field(
						v.union(
							v.object({ constructor: field(v.string()) }),
							v.object({ kind: field(v.id("players")) }),
						),
					),
				},
			}),
		]);
		const LONG = Array.from(
			{ length: 30 },
			(_, i) =>
				`k17long${String(i).padStart(2, "0")}000000000000000000000`,
		);
		const awkward = { "it's": P[0], "back\\slash": P[1], "": P[2] };
		const edgeDocs: Record<string, object[]> = {
			players: docs.players,
			edges: [
				{
					_id: "edge1",
					_creationTime: t,
					quoted: awkward,
					labels: awkward,
					tagged: [P[0], "o'clock", P[1]],
					optionalList: [P[0]],
					optionalObject: { p: P[1] },
					// Rewritten to the raw text 36.0 below; JSON.stringify drops the ".0".
					stats: [{ playerId: P[0], speed: "@36.0@" }],
					long: LONG,
					blob: { $bytes: "AAEC" },
					owner: { kind: "u", ref: P[0] },
					byOwner: { [P[0]]: 2, system: 1 },
					proto: { kind: P[0] },
				},
				{
					_id: "edge2",
					_creationTime: t + 1,
					quoted: awkward,
					labels: {},
					tagged: [],
					stats: [],
					long: [],
					blob: { [P[0]]: 1 },
					owner: { kind: "s", ref: "free text" },
					byOwner: {},
					proto: { constructor: "x" },
				},
			],
		};

		let ctx: Awaited<ReturnType<typeof freshSchemaClient>>;
		let edgeDir: string;
		let warnings: string[];
		let edge1: Row;
		let edge2: Row;

		beforeAll(async () => {
			edgeDir = writeExportDir(edgeDocs);
			const file = join(edgeDir, "edges", "documents.jsonl");
			writeFileSync(
				file,
				readFileSync(file, "utf8").replace('"@36.0@"', "36.0"),
			);
			ctx = await freshSchemaClient("nested_edges");
			const result = await importConvexExport({
				schema: parseExportedSchema(edgeSchema),
				source: edgeDir,
				client: ctx.client,
				applySchema: true,
			});
			warnings = result.warnings;
			const rows = await ctx.client.query(
				"SELECT * FROM edges ORDER BY created_at",
			);
			[edge1, edge2] = rows.rows as Row[];
		});

		afterAll(async () => {
			await ctx?.cleanup();
			if (edgeDir !== undefined) {
				rmSync(edgeDir, { recursive: true, force: true });
			}
		});

		const unconvertible = (path: string, reason: string) =>
			`table "edges": can't convert the ids in "${path}" (${reason}), so they stay Convex id strings in the jsonb and won't match the uuid ids. Convert them by hand, or use --id-strategy text.`;

		test("object keys with a quote, a backslash or no characters convert", () => {
			const expected = {
				"it's": uuid(P[0]),
				"back\\slash": uuid(P[1]),
				"": uuid(P[2]),
			};
			expect(edge1.quoted).toEqual(expected);
			// Record string keys are kept as they are; the id values convert.
			expect(edge1.labels).toEqual(expected);
			expect(edge2.labels).toEqual({});
		});

		test("a union literal with a quote is left alone", () => {
			expect(edge1.tagged).toEqual([uuid(P[0]), "o'clock", uuid(P[1])]);
		});

		test("an absent optional array or object stays SQL NULL", async () => {
			expect(edge1.optional_list).toEqual([uuid(P[0])]);
			expect(edge1.optional_object).toEqual({ p: uuid(P[1]) });
			const res = await ctx.client.query(
				"SELECT optional_list IS NULL AS list, optional_object IS NULL AS obj FROM edges WHERE created_at = (SELECT max(created_at) FROM edges)",
			);
			expect(res.rows[0]).toEqual({ list: true, obj: true });
		});

		test("a nested float keeps its text form", async () => {
			const res = await ctx.client.query(
				"SELECT stats::text AS stats FROM edges ORDER BY created_at LIMIT 1",
			);
			expect((res.rows[0] as { stats: string }).stats).toBe(
				`[{"speed": 36.0, "playerId": "${uuid(P[0])}"}]`,
			);
		});

		test("an array of more than 20 ids keeps its order", () => {
			expect(edge1.long).toEqual(LONG.map(uuid));
			expect(edge2.long).toEqual([]);
		});

		test("a record of ids in a union with v.bytes is left alone, with a warning", () => {
			expect(edge1.blob).toEqual({ $bytes: "AAEC" });
			expect(edge2.blob).toEqual({ [P[0]]: 1 });
			expect(warnings).toContain(
				unconvertible(
					"edges.blob",
					"a union mixes v.record() with another object type",
				),
			);
		});

		test("a key that's an id in one union member and a string in another is left alone, with a warning", () => {
			expect(edge1.owner).toEqual({ kind: "u", ref: P[0] });
			expect(edge2.owner).toEqual({ kind: "s", ref: "free text" });
			expect(warnings).toContain(
				unconvertible(
					"edges.owner.ref",
					"a union mixes v.id() with other strings",
				),
			);
		});

		test("record keys that are ids or a string literal convert, leaving the literal", () => {
			expect(edge1.by_owner).toEqual({ [uuid(P[0])]: 2, system: 1 });
			expect(warnings.some((w) => w.includes("edges.by_owner"))).toBe(
				false,
			);
			expect(warnings.some((w) => w.includes("edges.byOwner"))).toBe(
				false,
			);
		});

		test("a key named after an Object.prototype member doesn't break the plan", () => {
			expect(edge1.proto).toEqual({ kind: uuid(P[0]) });
			expect(edge2.proto).toEqual({ constructor: "x" });
		});
	});
});
