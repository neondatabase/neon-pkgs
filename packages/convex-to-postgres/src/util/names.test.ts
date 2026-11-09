import { describe, expect, test } from "vitest";
import { quoteIdentIfNeeded, toPgName, toSnakeCase } from "./names.js";

describe("toSnakeCase", () => {
	test.each([
		// camelCase / acronym splits (unchanged behavior).
		["authorId", "author_id"],
		["userProfiles", "user_profiles"],
		["name", "name"],
		["already_snake", "already_snake"],
		["HTTPStatus", "http_status"],
		["id", "id"],
		["createdAtMs", "created_at_ms"],
		["myField", "my_field"],
		// Non-camelCase separators collapse to a single underscore.
		["my-field", "my_field"],
		["a.b", "a_b"],
		["foo bar", "foo_bar"],
		["user-id", "user_id"],
		// Leading digit gets an underscore prefix.
		["2fa", "_2fa"],
		// Multiple consecutive separators collapse to one underscore.
		["a--b", "a_b"],
		["foo  bar", "foo_bar"],
		["a.-_b", "a_b"],
		// Leading/trailing separators are trimmed.
		["-foo-", "foo"],
		["_foo_", "foo"],
		["  spaced  ", "spaced"],
		// Combined: separators plus camelCase plus a leading digit.
		["1st-placeValue", "_1st_place_value"],
	])("converts %s to %s", (input, expected) => {
		expect(toSnakeCase(input)).toBe(expected);
	});
});

describe("quoteIdentIfNeeded", () => {
	test("leaves safe lowercase identifiers unquoted", () => {
		expect(quoteIdentIfNeeded("author_id")).toBe("author_id");
		expect(quoteIdentIfNeeded("created_at")).toBe("created_at");
		expect(quoteIdentIfNeeded("id")).toBe("id");
	});

	test("quotes identifiers that would be folded or are invalid unquoted", () => {
		expect(quoteIdentIfNeeded("authorId")).toBe('"authorId"');
		expect(quoteIdentIfNeeded("1stPlace")).toBe('"1stPlace"');
		expect(quoteIdentIfNeeded("has space")).toBe('"has space"');
	});

	test("escapes embedded double quotes", () => {
		expect(quoteIdentIfNeeded('a"b')).toBe('"a""b"');
	});

	test("quotes reserved keywords even though they look safe unquoted", () => {
		expect(quoteIdentIfNeeded("user")).toBe('"user"');
		expect(quoteIdentIfNeeded("null")).toBe('"null"');
		expect(quoteIdentIfNeeded("union")).toBe('"union"');
		expect(quoteIdentIfNeeded("order")).toBe('"order"');
	});

	test("leaves common non-reserved names unquoted", () => {
		for (const name of ["name", "status", "count", "kind", "data", "key"]) {
			expect(quoteIdentIfNeeded(name)).toBe(name);
		}
	});
});

describe("toPgName", () => {
	test("snake-cases when enabled", () => {
		expect(toPgName("authorId", true)).toBe("author_id");
	});

	test("keeps names verbatim when disabled", () => {
		expect(toPgName("authorId", false)).toBe("authorId");
	});
});
