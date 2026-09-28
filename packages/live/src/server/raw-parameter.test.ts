import { describe, expect, it } from "vitest";

import { pgParam } from "./raw-parameter.js";
import { prepareRawSqlQuery, type RawSqlParameter, rawSql } from "./raw-sql.js";

describe("raw SQL PostgreSQL parameters", () => {
	it("leaves bare primitive types for PostgreSQL to infer", () => {
		expect(parameters("text", 42, true, 42n, null)).toEqual([
			{ typeOid: 0, value: "text" },
			{ typeOid: 0, value: "42" },
			{ typeOid: 0, value: "true" },
			{ typeOid: 0, value: "42" },
			{ typeOid: 0, value: null },
		]);
	});

	it("uses stable OIDs for named built-in types", () => {
		expect(
			parameters(
				pgParam.text("uuid", "8ea9c0cc-6bf1-4d30-b85f-8415106215cf"),
				pgParam.text("numeric(12, 2)", "123.45"),
				pgParam.text(
					"timestamp(3) with time zone",
					"2026-09-18 12:34:56Z",
				),
			),
		).toEqual([
			{ typeOid: 2950, value: "8ea9c0cc-6bf1-4d30-b85f-8415106215cf" },
			{ typeOid: 1700, value: "123.45" },
			{ typeOid: 1184, value: "2026-09-18 12:34:56Z" },
		]);
	});

	it("falls back to inference for database-specific types", () => {
		expect(
			parameters(
				pgParam.text("app.order_status", "pending"),
				pgParam.array("app.order_status", ["pending", "fulfilled"]),
			),
		).toEqual([
			{ typeOid: 0, value: "pending" },
			{ typeOid: 0, value: '{"pending","fulfilled"}' },
		]);
	});

	it("distinguishes date, timestamp, and timestamptz", () => {
		const instant = new Date("2026-09-18T12:34:56.789Z");

		expect(
			parameters(
				pgParam.date(instant),
				pgParam.timestamp(instant),
				pgParam.timestamptz(instant),
			),
		).toEqual([
			{ typeOid: 1082, value: "2026-09-18" },
			{ typeOid: 1114, value: "2026-09-18 12:34:56.789" },
			{ typeOid: 1184, value: "2026-09-18T12:34:56.789Z" },
		]);
	});

	it("distinguishes JSON null from SQL NULL", () => {
		expect(
			parameters(
				pgParam.json(null),
				pgParam.jsonb({ enabled: true }),
				null,
			),
		).toEqual([
			{ typeOid: 114, value: "null" },
			{ typeOid: 3802, value: '{"enabled":true}' },
			{ typeOid: 0, value: null },
		]);
	});

	it("encodes and snapshots bytea values", () => {
		const bytes = Uint8Array.of(0, 15, 16, 255);
		const parameter = pgParam.bytea(bytes);
		bytes.fill(42);

		expect(parameters(parameter)).toEqual([
			{ typeOid: 17, value: "\\x000f10ff" },
		]);
	});

	it("encodes nested arrays, escaping, and SQL NULL", () => {
		const values = [
			["plain", 'a"b'],
			["back\\slash", null],
		];
		const parameter = pgParam.array("text", values);
		values.length = 0;

		expect(parameters(parameter)).toEqual([
			{
				typeOid: 1009,
				value: '{{"plain","a\\"b"},{"back\\\\slash",NULL}}',
			},
		]);
		expect(
			parameters(
				pgParam.array("integer", [
					[1, 2],
					[3, null],
				]),
			),
		).toEqual([
			{
				typeOid: 1007,
				value: '{{"1","2"},{"3",NULL}}',
			},
		]);
		expect(
			parameters(pgParam.array("box", ["(1,1),(0,0)", "(3,3),(2,2)"])),
		).toEqual([
			{
				typeOid: 1020,
				value: '{"(1,1),(0,0)";"(3,3),(2,2)"}',
			},
		]);
	});

	it("encodes arrays of values with type-specific text formats", () => {
		const instant = new Date("2026-09-18T12:34:56.789Z");

		expect(
			parameters(
				pgParam.array("timestamptz", [instant]),
				pgParam.array("jsonb", [{ enabled: true }]),
				pgParam.array("bytea", [Uint8Array.of(0xde, 0xad)]),
			),
		).toEqual([
			{ typeOid: 1185, value: '{"2026-09-18T12:34:56.789Z"}' },
			{ typeOid: 3807, value: '{"{\\"enabled\\":true}"}' },
			{ typeOid: 1001, value: '{"\\\\xdead"}' },
		]);
	});

	it("rejects values that cannot be encoded", () => {
		const cyclic: { self?: unknown } = {};
		cyclic.self = cyclic;

		expect(() => pgParam.date(new Date(Number.NaN))).toThrow(
			"Invalid Date",
		);
		expect(() => pgParam.json(undefined)).toThrow("cannot be encoded");
		expect(() => pgParam.json(cyclic)).toThrow("cannot be encoded");
		expect(() => pgParam.array("text", [{}])).toThrow("cannot be encoded");
		expect(() => pgParam.array("integer", [new Date()])).toThrow(
			"Date cannot be encoded",
		);
	});
});

function parameters(...values: RawSqlParameter[]) {
	return prepareRawSqlQuery(rawSql("select 1", values)).parameters;
}
