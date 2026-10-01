import { pgParam } from "@neon/live/server";
import { describe, expect, it } from "vitest";
import { encodeKyselyParameter } from "./parameter.js";

describe("Kysely PostgreSQL parameter encoding", () => {
	it.each([
		["text", "text"],
		[42, "42"],
		[true, "true"],
		[9_007_199_254_740_993n, "9007199254740993"],
		[null, null],
		[undefined, null],
	])("encodes a scalar value", (input, expected) => {
		expect(encodeKyselyParameter(input)).toEqual({
			typeOid: 0,
			value: expected,
		});
	});

	it("encodes byte views as PostgreSQL hexadecimal bytea text", () => {
		const words = new Uint16Array([0x1234, 0xabcd]);
		const expected = Array.from(new Uint8Array(words.buffer), (byte) =>
			byte.toString(16).padStart(2, "0"),
		).join("");
		expect(encodeKyselyParameter(words)).toEqual({
			typeOid: 0,
			value: `\\x${expected}`,
		});
	});

	it("encodes nested PostgreSQL arrays with NULL and escaped values", () => {
		expect(
			encodeKyselyParameter([
				[1, 2],
				[null, 'quote"slash\\'],
			]),
		).toEqual({
			typeOid: 0,
			value: '{{"1","2"},{NULL,"quote\\"slash\\\\"}}',
		});
	});

	it("uses JSON for ordinary objects", () => {
		expect(
			encodeKyselyParameter({ enabled: true, nested: [1, null] }),
		).toEqual({
			typeOid: 0,
			value: '{"enabled":true,"nested":[1,null]}',
		});
	});

	it("supports node-postgres toPostgres values", () => {
		const value = {
			toPostgres(prepare: (nested: unknown) => string | null) {
				return `point(${prepare(1)},${prepare(2)})`;
			},
		};
		expect(encodeKyselyParameter(value)).toEqual({
			typeOid: 0,
			value: "point(1,2)",
		});
	});

	it("preserves explicit pgParam encodings and OIDs", () => {
		expect(encodeKyselyParameter(pgParam.jsonb({ enabled: true }))).toEqual(
			{
				typeOid: 3802,
				value: '{"enabled":true}',
			},
		);
		expect(
			encodeKyselyParameter(pgParam.array("text", ["a", "b"])),
		).toEqual({
			typeOid: 1009,
			value: '{"a","b"}',
		});
	});

	it("rejects invalid dates, circular values, and unsupported primitives", () => {
		const circular: unknown[] = [];
		circular.push(circular);
		expect(() => encodeKyselyParameter(new Date(Number.NaN))).toThrow(
			"Invalid Date",
		);
		expect(() => encodeKyselyParameter(circular)).toThrow(
			"Circular reference",
		);
		expect(() => encodeKyselyParameter(Symbol("value"))).toThrow(
			"cannot be encoded",
		);
	});

	it("rejects JSON values that cannot be serialized", () => {
		expect(() => encodeKyselyParameter({ value: 1n })).toThrow(
			"JSON parameter",
		);
	});
});
