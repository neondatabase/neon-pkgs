import { describe, expect, test } from "vitest";
import { jsonTextAccessor, jsonValueAccessor, quoteSqlString } from "./sql.js";

describe("quoteSqlString", () => {
	test("wraps in single quotes", () => {
		expect(quoteSqlString("hello")).toBe("'hello'");
	});

	test("doubles embedded single quotes", () => {
		expect(quoteSqlString("O'Brien")).toBe("'O''Brien'");
	});

	test("embeds a raw JSONL line safely", () => {
		const line = `{"name":"it's fine","n":1.0}`;
		expect(quoteSqlString(line)).toBe(`'{"name":"it''s fine","n":1.0}'`);
	});
});

describe("accessors", () => {
	test("jsonTextAccessor reads a field as text", () => {
		expect(jsonTextAccessor("authorId")).toBe("doc->>'authorId'");
	});

	test("jsonValueAccessor reads a field as jsonb", () => {
		expect(jsonValueAccessor("meta")).toBe("doc->'meta'");
	});
});
