import { describe, expect, expectTypeOf, it, vi } from "vitest";
import type { NeonLiveClientOptions } from "../types.js";
import { pgTypeOids } from "./oids.js";
import {
	createParserRegistry,
	defineParsers,
	postgresJsParsers,
} from "./parsers.js";
import {
	decodeRow,
	PostgresValueParserError,
	validateColumns,
} from "./value-decoder.js";

const TEXT_COLUMN = {
	name: "value",
	typmod: -1,
	codec: "pg_text",
} as const;

describe("PostgreSQL result parsers", () => {
	it("accepts parser objects passed directly to the client", () => {
		const customTypeOid = 90_000;
		const options: NeonLiveClientOptions = {
			url: "wss://live.neon.tech/example",
			parsers: {
				[pgTypeOids.int8]: (value) => {
					expectTypeOf(value).toEqualTypeOf<string>();
					return BigInt(value);
				},
				[pgTypeOids.bytea]: (value) => {
					expectTypeOf(value).toEqualTypeOf<Uint8Array>();
					return value.byteLength;
				},
				[customTypeOid]: (value: string) => {
					expectTypeOf(value).toEqualTypeOf<string>();
					return value;
				},
			},
		};

		expect(options.parsers).toBeDefined();
	});

	it("provides contextual input types for text and bytea parser definitions", () => {
		defineParsers({
			[pgTypeOids.int8]: (value) => {
				expectTypeOf(value).toEqualTypeOf<string>();
				return BigInt(value);
			},
			[pgTypeOids.bytea]: (value) => {
				expectTypeOf(value).toEqualTypeOf<Uint8Array>();
				return value.byteLength;
			},
		});
	});

	it.each([
		[pgTypeOids.bool, "t", true],
		[pgTypeOids.bool, "f", false],
		[pgTypeOids.int2, "-32768", -32_768],
		[pgTypeOids.int4, "2147483647", 2_147_483_647],
		[pgTypeOids.oid, "4294967295", 4_294_967_295],
		[pgTypeOids.int8, "9223372036854775807", "9223372036854775807"],
		[pgTypeOids.numeric, "1234567890.000001", "1234567890.000001"],
		[pgTypeOids.float4, "1.25", 1.25],
		[pgTypeOids.float8, "-Infinity", -Infinity],
		[pgTypeOids.time, "12:34:56.123456", "12:34:56.123456"],
		[pgTypeOids.timetz, "12:34:56+02", "12:34:56+02"],
		[pgTypeOids.interval, "1 day 02:03:04", "1 day 02:03:04"],
		[
			pgTypeOids.uuid,
			"123e4567-e89b-12d3-a456-426614174000",
			"123e4567-e89b-12d3-a456-426614174000",
		],
	])("decodes OID %s to a familiar JavaScript value", (oid, input, expected) => {
		expect(parseText(oid, input)).toEqual(expected);
	});

	it("parses JSON and JSONB", () => {
		expect(parseText(pgTypeOids.json, '{"enabled":true}')).toEqual({
			enabled: true,
		});
		expect(parseText(pgTypeOids.jsonb, "[1,null,3]")).toEqual([1, null, 3]);
	});

	it("uses local time for date and zone-less timestamp", () => {
		const date = parseText(pgTypeOids.date, "2026-09-28") as Date;
		expect([
			date.getFullYear(),
			date.getMonth() + 1,
			date.getDate(),
			date.getHours(),
		]).toEqual([2026, 9, 28, 0]);

		const timestamp = parseText(
			pgTypeOids.timestamp,
			"2026-09-28 13:14:15.123456",
		) as Date;
		expect([
			timestamp.getFullYear(),
			timestamp.getMonth() + 1,
			timestamp.getDate(),
			timestamp.getHours(),
			timestamp.getMinutes(),
			timestamp.getSeconds(),
			timestamp.getMilliseconds(),
		]).toEqual([2026, 9, 28, 13, 14, 15, 123]);
	});

	it("respects timestamptz offsets and truncates PostgreSQL microseconds", () => {
		const value = parseText(
			pgTypeOids.timestamptz,
			"2026-09-28 13:14:15.987654+02:30",
		) as Date;
		expect(value.toISOString()).toBe("2026-09-28T10:44:15.987Z");
	});

	it("provides the Postgres.js UTC date overlay", () => {
		const registry = createParserRegistry(postgresJsParsers);
		const date = registry.parse(pgTypeOids.date, "2026-09-28") as Date;
		expect(date.toISOString()).toBe("2026-09-28T00:00:00.000Z");
		const dates = registry.parse(
			pgTypeOids.dateArray,
			"{2026-09-28,2026-09-29}",
		) as Date[];
		expect(dates.map((value) => value.toISOString())).toEqual([
			"2026-09-28T00:00:00.000Z",
			"2026-09-29T00:00:00.000Z",
		]);
	});

	it("decodes bytea transport before invoking the byte parser", () => {
		const bytes = vi.fn((value: Uint8Array) => [...value]);
		const parsers = createParserRegistry(
			defineParsers({
				[pgTypeOids.bytea]: bytes,
			}),
		);
		const row = decodeRow<{ value: number[] }>(
			[{ base64: "AP+A" }],
			[{ ...TEXT_COLUMN, type_oid: pgTypeOids.bytea, codec: "bytes" }],
			parsers,
		);
		expect(row.value).toEqual([0, 255, 128]);
		expect(bytes).toHaveBeenCalledWith(new Uint8Array([0, 255, 128]));
	});

	it("recursively parses known arrays and preserves PostgreSQL NULL semantics", () => {
		expect(parseText(pgTypeOids.int4Array, "{{1,2},{3,NULL}}")).toEqual([
			[1, 2],
			[3, null],
		]);
		expect(
			parseText(pgTypeOids.textArray, `{"NULL",NULL,"","a,b"}`),
		).toEqual(["NULL", null, "", "a,b"]);
		expect(
			parseText(pgTypeOids.numericArray, "{1.0000000000001,-2}"),
		).toEqual(["1.0000000000001", "-2"]);
		expect(parseText(pgTypeOids.int4Array, "[0:1]={1,2}")).toEqual([1, 2]);
	});

	it("parses JSON and bytea array elements through their scalar parsers", () => {
		expect(
			parseText(pgTypeOids.jsonbArray, String.raw`{"{\"a\":1}","null"}`),
		).toEqual([{ a: 1 }, null]);
		expect(
			parseText(pgTypeOids.byteaArray, String.raw`{"\\x00ff",NULL}`),
		).toEqual([new Uint8Array([0, 255]), null]);
	});

	it("preserves arrays with non-comma delimiters as PostgreSQL text", () => {
		const value = "{(1,1),(0,0);(3,3),(2,2)}";
		expect(parseText(pgTypeOids.boxArray, value)).toBe(value);
	});

	it("applies scalar overrides recursively to their known array type", () => {
		const registry = createParserRegistry(
			defineParsers({
				[pgTypeOids.int8]: (value) => BigInt(value),
			}),
		);
		expect(registry.parse(pgTypeOids.int8Array, "{1,2}")).toEqual([1n, 2n]);
	});

	it("allows an explicit array parser to override recursive decoding", () => {
		const registry = createParserRegistry(
			defineParsers({
				[pgTypeOids.int4Array]: (value) => `raw:${value}`,
			}),
		);
		expect(registry.parse(pgTypeOids.int4Array, "{1,2}")).toBe("raw:{1,2}");
	});

	it("returns exact PostgreSQL text for unknown scalar and array OIDs", () => {
		const registry = createParserRegistry(undefined);
		expect(registry.parse(90000, "custom-value")).toBe("custom-value");
		expect(registry.parse(90001, "{a,b}")).toBe("{a,b}");
	});

	it("bypasses parsers for SQL NULL", () => {
		const parser = vi.fn(() => "parsed");
		const row = decodeRow<{ value: null }>(
			[null],
			[{ ...TEXT_COLUMN, type_oid: 90000 }],
			createParserRegistry({ 90000: parser }),
		);
		expect(row.value).toBeNull();
		expect(parser).not.toHaveBeenCalled();
	});

	it("snapshots parser configuration when the client registry is created", () => {
		const configured: Record<number, (value: string) => unknown> = {
			90000: (value) => `first:${value}`,
		};
		const registry = createParserRegistry(configured);
		configured[90000] = (value) => `second:${value}`;
		expect(registry.parse(90000, "value")).toBe("first:value");
	});

	it.each([
		[pgTypeOids.bool, "yes"],
		[pgTypeOids.int2, "32768"],
		[pgTypeOids.int4, "1.5"],
		[pgTypeOids.int8, "9223372036854775808"],
		[pgTypeOids.oid, "-1"],
		[pgTypeOids.float8, "1e999"],
		[pgTypeOids.numeric, "not-a-number"],
		[pgTypeOids.json, "{"],
		[pgTypeOids.date, "not-a-date"],
		[pgTypeOids.date, "2026-02-30"],
		[pgTypeOids.timestamp, "2026-09-28 24:00:00"],
		[pgTypeOids.timestamptz, "2026-09-28 12:00:00+02:99"],
		[pgTypeOids.int4Array, "{1,2"],
	])("rejects a malformed built-in OID %s value", (oid, input) => {
		expect(() => parseText(oid, input)).toThrow();
	});

	it("wraps parser failures with column metadata but not the raw value", () => {
		const original = new Error("custom failure");
		const parsers = createParserRegistry({
			90000: () => {
				throw original;
			},
		});
		let caught: unknown;
		try {
			decodeRow(
				["secret-personal-value"],
				[{ ...TEXT_COLUMN, name: "private_column", type_oid: 90000 }],
				parsers,
			);
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(PostgresValueParserError);
		expect(caught).toMatchObject({
			columnName: "private_column",
			oid: 90000,
			cause: original,
		});
		expect((caught as Error).message).toContain("private_column");
		expect((caught as Error).message).toContain("90000");
		expect((caught as Error).message).not.toContain(
			"secret-personal-value",
		);
	});

	it("enforces the protocol v1 OID/codec mapping", () => {
		expect(() =>
			validateColumns([{ ...TEXT_COLUMN, type_oid: pgTypeOids.bytea }]),
		).toThrow("requires the bytes codec");
		expect(() =>
			validateColumns([
				{ ...TEXT_COLUMN, type_oid: pgTypeOids.text, codec: "bytes" },
			]),
		).toThrow("requires the pg_text codec");
	});

	it("validates parser configuration eagerly", () => {
		expect(() => createParserRegistry([] as never)).toThrow(
			"OID-keyed object",
		);
		expect(() =>
			createParserRegistry({ 0: (value: string) => value }),
		).toThrow("Invalid PostgreSQL parser OID");
		expect(() =>
			createParserRegistry({ 23: "not a function" } as never),
		).toThrow("must be a function");
	});
});

function parseText(oid: number, value: string): unknown {
	return createParserRegistry(undefined).parse(oid, value);
}
