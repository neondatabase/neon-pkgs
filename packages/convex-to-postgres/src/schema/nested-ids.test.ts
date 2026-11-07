import { describe, expect, test } from "vitest";
import { generateTransformSql } from "../data/transform.js";
import { field, schema, table, v } from "../test-fixtures.js";
import { generateDdl } from "./generate-ddl.js";
import { planNestedIds } from "./nested-ids.js";
import { parseExportedSchema } from "./parse.js";

const DOC = "doc->'f'";

function convert(validator: ReturnType<typeof v.id>) {
	const plan = planNestedIds(validator, "t.f");
	return {
		sql: plan.convert === undefined ? undefined : plan.convert(DOC),
		unconvertible: plan.unconvertible,
	};
}

describe("planNestedIds: the select expression", () => {
	test("an array of ids hashes each element and keeps the order", () => {
		expect(convert(v.array(v.id("players"))).sql).toBe(
			"CASE jsonb_typeof(doc->'f') WHEN 'array' THEN " +
				"(SELECT coalesce(jsonb_agg(" +
				"CASE jsonb_typeof(e0.value) WHEN 'string' THEN to_jsonb(md5(e0.value #>> '{}')::uuid::text) ELSE e0.value END" +
				" ORDER BY e0.ord), '[]'::jsonb) FROM jsonb_array_elements(doc->'f') WITH ORDINALITY AS e0(value, ord))" +
				" ELSE doc->'f' END",
		);
	});

	test("an object rewrites only its id keys, so absent optional keys stay absent", () => {
		const { sql } = convert(
			v.object({
				playerId: field(v.id("players")),
				carId: field(v.id("cars"), true),
				position: field(v.number()),
			}),
		);
		expect(sql).toBe(
			"CASE jsonb_typeof(doc->'f') WHEN 'object' THEN " +
				"(SELECT coalesce(jsonb_object_agg(f0.key, CASE f0.key " +
				"WHEN 'carId' THEN CASE jsonb_typeof(f0.value) WHEN 'string' THEN to_jsonb(md5(f0.value #>> '{}')::uuid::text) ELSE f0.value END " +
				"WHEN 'playerId' THEN CASE jsonb_typeof(f0.value) WHEN 'string' THEN to_jsonb(md5(f0.value #>> '{}')::uuid::text) ELSE f0.value END " +
				"ELSE f0.value END), '{}'::jsonb) FROM jsonb_each(doc->'f') AS f0(key, value))" +
				" ELSE doc->'f' END",
		);
	});

	test("record values that are ids are hashed; string keys are kept", () => {
		const { sql } = convert(v.record(v.string(), v.id("cars")));
		expect(sql).toContain(
			"jsonb_object_agg(f0.key, CASE jsonb_typeof(f0.value)",
		);
		expect(sql).not.toContain("md5(f0.key)");
	});

	test("record keys that are ids are hashed too", () => {
		const { sql } = convert(v.record(v.id("players"), v.number()));
		expect(sql).toBe(
			"CASE jsonb_typeof(doc->'f') WHEN 'object' THEN " +
				"(SELECT coalesce(jsonb_object_agg(md5(f0.key)::uuid::text, f0.value), '{}'::jsonb) FROM jsonb_each(doc->'f') AS f0(key, value))" +
				" ELSE doc->'f' END",
		);
	});

	test("nesting uses a fresh alias per level", () => {
		const { sql } = convert(
			v.array(v.object({ ids: field(v.array(v.id("players"))) })),
		);
		expect(sql).toContain("AS e0(value, ord)");
		expect(sql).toContain("AS f1(key, value)");
		expect(sql).toContain(
			"jsonb_array_elements(f1.value) WITH ORDINALITY AS e2(value, ord)",
		);
	});

	test("a nullable id (union with v.null()) converts, and JSON null falls through", () => {
		expect(convert(v.array(v.union(v.id("players"), v.null()))).sql).toBe(
			convert(v.array(v.id("players"))).sql,
		);
	});

	test("a union of ids from different tables hashes them all the same way", () => {
		expect(convert(v.array(v.union(v.id("a"), v.id("b")))).sql).toBe(
			convert(v.array(v.id("a"))).sql,
		);
	});

	test("a union of ids and string literals leaves the literals alone", () => {
		const { sql, unconvertible } = convert(
			v.union(v.id("users"), v.literal("system")),
		);
		expect(unconvertible).toEqual([]);
		expect(sql).toBe(
			"CASE jsonb_typeof(doc->'f') WHEN 'string' THEN " +
				"CASE WHEN doc->'f' #>> '{}' IN ('system') THEN doc->'f' ELSE to_jsonb(md5(doc->'f' #>> '{}')::uuid::text) END" +
				" ELSE doc->'f' END",
		);
	});

	test("a discriminated union of objects merges the id keys of every member", () => {
		const { sql, unconvertible } = convert(
			v.union(
				v.object({
					kind: field(v.literal("player")),
					ref: field(v.id("players")),
				}),
				v.object({
					kind: field(v.literal("car")),
					ref: field(v.id("cars")),
					by: field(v.id("players")),
				}),
			),
		);
		expect(unconvertible).toEqual([]);
		expect(sql).toContain("WHEN 'by' THEN");
		expect(sql).toContain("WHEN 'ref' THEN");
		expect(sql).not.toContain("WHEN 'kind' THEN");
	});

	test("an array or an id in one union dispatches on the JSON type", () => {
		const { sql } = convert(
			v.union(v.id("players"), v.array(v.id("players"))),
		);
		expect(sql).toMatch(
			/^CASE jsonb_typeof\(doc->'f'\) WHEN 'string' THEN .* WHEN 'array' THEN .* ELSE doc->'f' END$/,
		);
	});

	test.each([
		["an array of numbers", v.array(v.number())],
		["an object without ids", v.object({ a: field(v.string()) })],
		["a string record", v.record(v.string(), v.string())],
		["v.any()", v.any()],
		["v.bytes()", v.bytes()],
		["a record with no validators", v.record()],
	])("%s needs no conversion and no warning", (_label, validator) => {
		expect(convert(validator)).toEqual({
			sql: undefined,
			unconvertible: [],
		});
	});
});

describe("planNestedIds: ids it can't convert", () => {
	test("a union of v.id() and v.string() can't tell the two apart", () => {
		expect(convert(v.array(v.union(v.id("players"), v.string())))).toEqual({
			sql: undefined,
			unconvertible: [
				["t.f[]", "a union mixes v.id() with other strings"],
			],
		});
	});

	test("a union of v.id() and v.any() can't either", () => {
		expect(
			convert(v.object({ x: field(v.union(v.id("a"), v.any())) })),
		).toEqual({
			sql: undefined,
			unconvertible: [["t.f.x", "a union mixes v.id() with v.any()"]],
		});
	});

	test("record keys that mix ids and strings stay, but the values still convert", () => {
		const { sql, unconvertible } = convert(
			v.record(v.union(v.id("a"), v.string()), v.id("b")),
		);
		expect(unconvertible).toEqual([
			["t.f keys", "the record's keys mix v.id() with other strings"],
		]);
		expect(sql).toContain(
			"jsonb_object_agg(f0.key, CASE jsonb_typeof(f0.value)",
		);
	});

	test("a union of a record and an object", () => {
		expect(
			convert(
				v.union(
					v.record(v.string(), v.id("a")),
					v.object({ x: field(v.string()) }),
				),
			),
		).toEqual({
			sql: undefined,
			unconvertible: [
				["t.f", "a union mixes v.record() with another object type"],
			],
		});
	});

	test("only the ambiguous part is left: other positions in the field still convert", () => {
		const { sql, unconvertible } = convert(
			v.object({
				good: field(v.id("a")),
				bad: field(v.union(v.id("a"), v.string())),
			}),
		);
		expect(unconvertible).toEqual([
			["t.f.bad", "a union mixes v.id() with other strings"],
		]);
		expect(sql).toContain("WHEN 'good' THEN");
		expect(sql).not.toContain("WHEN 'bad' THEN");
	});
});

describe("planNestedIds: review regressions", () => {
	test.each([
		"constructor",
		"toString",
		"valueOf",
		"__proto__",
	])("an object-union key named %s that only one member declares doesn't throw", (key) => {
		const validator = v.union(
			v.object({ [key]: field(v.string()) }),
			v.object({ kind: field(v.id("users")) }),
		);
		const { sql, unconvertible } = convert(validator);
		expect(unconvertible).toEqual([]);
		expect(sql).toContain("WHEN 'kind' THEN");
		expect(sql).not.toContain(`WHEN '${key}' THEN`);
	});

	test("planSchema survives a prototype-named key in a union of objects", () => {
		const parsed = parseExportedSchema(
			schema([
				table({ name: "users", fields: { name: field(v.string()) } }),
				table({
					name: "t",
					fields: {
						f: field(
							v.union(
								v.object({ constructor: field(v.string()) }),
								v.object({ kind: field(v.id("users")) }),
							),
						),
					},
				}),
			]),
		);
		expect(() => generateTransformSql(parsed)).not.toThrow();
		expect(generateTransformSql(parsed)).toContain("WHEN 'kind' THEN");
	});

	test("a discriminated union whose shared key is an id in one member and a string in another warns", () => {
		// Dispatch is per key name, not per discriminator value.
		expect(
			convert(
				v.union(
					v.object({
						kind: field(v.literal("u")),
						ref: field(v.id("users")),
					}),
					v.object({
						kind: field(v.literal("s")),
						ref: field(v.string()),
					}),
				),
			),
		).toEqual({
			sql: undefined,
			unconvertible: [
				["t.f.ref", "a union mixes v.id() with other strings"],
			],
		});
	});

	test("record keys that are ids or string literals convert, leaving the literals", () => {
		const { sql, unconvertible } = convert(
			v.record(v.union(v.id("users"), v.literal("system")), v.number()),
		);
		expect(unconvertible).toEqual([]);
		expect(sql).toBe(
			"CASE jsonb_typeof(doc->'f') WHEN 'object' THEN " +
				"(SELECT coalesce(jsonb_object_agg(CASE WHEN f0.key IN ('system') THEN f0.key ELSE md5(f0.key)::uuid::text END, f0.value), '{}'::jsonb) FROM jsonb_each(doc->'f') AS f0(key, value))" +
				" ELSE doc->'f' END",
		);
	});

	test("a record of ids in a union with v.bytes warns and converts nothing", () => {
		// Converting would rewrite the bytes value's `$bytes` key.
		expect(
			convert(v.union(v.record(v.id("users"), v.number()), v.bytes())),
		).toEqual({
			sql: undefined,
			unconvertible: [
				["t.f", "a union mixes v.record() with another object type"],
			],
		});
	});

	test("an unknown validator type is named in the reason, not reported as v.any()", () => {
		const unknown = { type: "mystery" } as unknown as ReturnType<
			typeof v.id
		>;
		expect(convert(v.array(v.union(v.id("a"), unknown)))).toEqual({
			sql: undefined,
			unconvertible: [["t.f[]", "a union mixes v.id() with v.mystery()"]],
		});
	});

	test("quotes object keys and union literals with quotes and backslashes", () => {
		const { sql } = convert(
			v.object({
				"it's": field(v.id("a")),
				"back\\slash": field(v.id("a")),
				"": field(v.id("a")),
				tag: field(v.union(v.id("a"), v.literal("o'clock"))),
			}),
		);
		expect(sql).toContain("WHEN '' THEN");
		expect(sql).toContain("WHEN 'back\\slash' THEN");
		expect(sql).toContain("WHEN 'it''s' THEN");
		expect(sql).toContain("IN ('o''clock')");
	});
});

describe("nested ids in the generated SQL", () => {
	const exported = schema([
		table({ name: "players", fields: { name: field(v.string()) } }),
		table({
			name: "races",
			fields: {
				participants: field(v.array(v.id("players"))),
				ref: field(v.union(v.id("players"), v.string()), true),
				notes: field(v.array(v.string())),
			},
		}),
	]);
	const parsed = parseExportedSchema(exported);

	test("uuid (default): the transform converts the array, and the column stays jsonb", () => {
		const sql = generateTransformSql(parsed);
		expect(sql).toContain(
			`${planNestedIds(v.array(v.id("players")), "races.participants").convert?.("doc->'participants'")},`,
		);
		// A jsonb column with no ids is copied as before.
		expect(sql).toContain("    doc->'notes'\nFROM _convex_races;");
		expect(generateDdl(parsed).sql).toContain(
			"participants jsonb NOT NULL",
		);
	});

	test("uuid: a warning names each field the tool can't convert", () => {
		expect(generateDdl(parsed).warnings).toEqual([
			`table "races": field "races.ref" is a union of mixed or non-literal types; storing it as jsonb.`,
			`table "races": can't convert the ids in "races.ref" (a union mixes v.id() with other strings), so they stay Convex id strings in the jsonb and won't match the uuid ids. Convert them by hand, or use --id-strategy text.`,
		]);
	});

	test("a top-level union of an id and a literal is jsonb, with the id converted inside it", () => {
		const parsedUnion = parseExportedSchema(
			schema([
				table({ name: "users", fields: { name: field(v.string()) } }),
				table({
					name: "t",
					fields: {
						owner: field(
							v.union(v.id("users"), v.literal("system")),
						),
					},
				}),
			]),
		);
		const { sql } = generateDdl(parsedUnion);
		expect(sql).toContain("owner jsonb NOT NULL");
		expect(sql).not.toContain("REFERENCES");
		expect(generateTransformSql(parsedUnion)).toContain(
			"CASE WHEN doc->'owner' #>> '{}' IN ('system') THEN doc->'owner' ELSE to_jsonb(md5(doc->'owner' #>> '{}')::uuid::text) END",
		);
	});

	test("text: ids stay verbatim, so nothing is converted and nothing warns", () => {
		const sql = generateTransformSql(parsed, { idStrategy: "text" });
		expect(sql).toContain("    doc->'participants',\n");
		expect(sql).not.toContain("md5(");
		expect(
			generateDdl(parsed, { idStrategy: "text" }).warnings.some((w) =>
				w.includes("can't convert the ids"),
			),
		).toBe(false);
	});
});
