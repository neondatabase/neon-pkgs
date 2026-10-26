import { describe, expect, test } from "vitest";
import { resolveOptions } from "../options.js";
import { v } from "../test-fixtures.js";
import type { MapContext } from "./map-types.js";
import { mapValidator } from "./map-types.js";

function ctx(
	overrides: Partial<{
		idStrategy: "uuid" | "text";
		tables: string[];
	}> = {},
): MapContext {
	return {
		options: resolveOptions({ idStrategy: overrides.idStrategy }),
		schemaTableNames: new Set(overrides.tables ?? []),
	};
}

describe("mapValidator scalars", () => {
	test.each([
		[v.string(), "text", "text"],
		[v.number(), "double precision", "number"],
		[v.boolean(), "boolean", "boolean"],
		[v.int64(), "bigint", "bigint"],
		[v.bytes(), "bytea", "bytes"],
	])("%o -> %s", (validator, pgType, selectKind) => {
		const mapped = mapValidator(validator, ctx(), "t.f");
		expect(mapped.pgType).toBe(pgType);
		expect(mapped.selectKind).toBe(selectKind);
		expect(mapped.warnings).toEqual([]);
	});

	test.each([
		v.object({}),
		v.array(v.string()),
		v.record(),
		v.any(),
		v.null(),
	])("%o -> jsonb", (validator) => {
		const mapped = mapValidator(validator, ctx(), "t.f");
		expect(mapped.pgType).toBe("jsonb");
		expect(mapped.selectKind).toBe("json");
	});

	test("v.commitTs() -> bigint with a warning", () => {
		const mapped = mapValidator(v.commitTs(), ctx(), "t.ts");
		expect(mapped.pgType).toBe("bigint");
		expect(mapped.selectKind).toBe("bigint");
		expect(mapped.warnings[0]).toContain("commitTs");
	});

	test("an unrecognized validator type degrades to jsonb with a warning", () => {
		const unknown = { type: "future_kind" } as unknown as Parameters<
			typeof mapValidator
		>[0];
		const mapped = mapValidator(unknown, ctx(), "t.weird");
		expect(mapped.pgType).toBe("jsonb");
		expect(mapped.selectKind).toBe("json");
		expect(mapped.warnings[0]).toContain("future_kind");
	});
});

describe("mapValidator id references", () => {
	test("emits a foreign key when the target table is in the schema (uuid)", () => {
		const mapped = mapValidator(
			v.id("users"),
			ctx({ tables: ["users"] }),
			"t.f",
		);
		expect(mapped.pgType).toBe("uuid");
		expect(mapped.selectKind).toBe("id");
		expect(mapped.references).toBe("users");
		expect(mapped.warnings).toEqual([]);
	});

	test("snake-cases the referenced table name", () => {
		const mapped = mapValidator(
			v.id("userProfiles"),
			ctx({ tables: ["userProfiles"] }),
			"t.f",
		);
		expect(mapped.references).toBe("user_profiles");
	});

	test("uses text under the text strategy", () => {
		const mapped = mapValidator(
			v.id("users"),
			ctx({ idStrategy: "text", tables: ["users"] }),
			"t.f",
		);
		expect(mapped.pgType).toBe("text");
		expect(mapped.references).toBe("users");
	});

	test("omits the foreign key and warns for an out-of-schema target", () => {
		const mapped = mapValidator(
			v.id("_storage"),
			ctx({ tables: ["users"] }),
			"t.f",
		);
		expect(mapped.pgType).toBe("uuid");
		expect(mapped.references).toBeUndefined();
		expect(mapped.warnings).toHaveLength(1);
		expect(mapped.warnings[0]).toContain("_storage");
	});
});

describe("mapValidator literals and unions", () => {
	test("a lone string literal maps to text", () => {
		const mapped = mapValidator(v.literal("draft"), ctx(), "t.f");
		expect(mapped.pgType).toBe("text");
		expect(mapped.selectKind).toBe("text");
	});

	test("a lone number literal maps to double precision", () => {
		const mapped = mapValidator(v.literal(42), ctx(), "t.f");
		expect(mapped.pgType).toBe("double precision");
	});

	test("a union of string literals maps to text with a CHECK list", () => {
		const mapped = mapValidator(
			v.union(v.literal("draft"), v.literal("published")),
			ctx(),
			"t.status",
		);
		expect(mapped.pgType).toBe("text");
		expect(mapped.checkIn).toEqual(["draft", "published"]);
	});

	test("a union of number literals maps to double precision with no CHECK", () => {
		const mapped = mapValidator(
			v.union(v.literal(1), v.literal(2)),
			ctx(),
			"t.f",
		);
		expect(mapped.pgType).toBe("double precision");
		expect(mapped.checkIn).toBeUndefined();
	});

	test("a union of boolean literals maps to boolean", () => {
		const mapped = mapValidator(
			v.union(v.literal(true), v.literal(false)),
			ctx(),
			"t.f",
		);
		expect(mapped.pgType).toBe("boolean");
	});

	test("a union with null maps on the sole remaining member", () => {
		const mapped = mapValidator(
			v.union(v.null(), v.string()),
			ctx(),
			"t.f",
		);
		expect(mapped.pgType).toBe("text");
	});

	test("a mixed union falls back to jsonb with a warning", () => {
		const mapped = mapValidator(
			v.union(v.literal("a"), v.literal(1)),
			ctx(),
			"t.mixed",
		);
		expect(mapped.pgType).toBe("jsonb");
		expect(mapped.warnings[0]).toContain("t.mixed");
	});

	test("a union of non-literal members falls back to jsonb", () => {
		const mapped = mapValidator(
			v.union(v.string(), v.number()),
			ctx(),
			"t.f",
		);
		expect(mapped.pgType).toBe("jsonb");
	});
});
