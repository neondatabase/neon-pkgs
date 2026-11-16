import { describe, expect, test } from "vitest";
import * as z from "zod";
import {
	credential,
	isCredential,
	noContent,
	outputDataSchema,
	outputSchemaFor,
	toStructuredContent,
	withoutCredentials,
	withoutOutputFields,
} from "./output.js";

const role = z.looseObject({
	name: z.string(),
	password: credential(z.string()),
});

describe("outputSchemaFor", () => {
	test("keeps an object data schema as the output schema", () => {
		expect(outputSchemaFor(role)).toBe(role);
		expect(outputDataSchema(role)).toBe(role);
	});

	test.each([
		[
			"an array",
			z.array(role),
			[{ name: "a" }],
			{ items: [{ name: "a" }] },
		],
		["null", z.null(), null, {}],
		["a string", z.string(), "postgres://", { value: "postgres://" }],
		["a number", z.number(), 3, { value: 3 }],
		["a boolean", z.boolean(), true, { value: true }],
	])("wraps %s the way toStructuredContent does", (_, data, value, wrapped) => {
		const outputSchema = outputSchemaFor(data);
		expect(toStructuredContent(value)).toEqual(wrapped);
		expect(outputSchema.parse(toStructuredContent(value))).toEqual(wrapped);
		expect(outputDataSchema(outputSchema)).toBe(data);
	});

	test("makes every field of a nullable object optional", () => {
		const outputSchema = outputSchemaFor(noContent);
		expect(outputSchema.parse(toStructuredContent(null))).toEqual({});
		expect(outputSchema.parse({ anything: 1 })).toEqual({ anything: 1 });

		const nullableRole = outputSchemaFor(role.nullable());
		expect(nullableRole.parse({})).toEqual({});
		expect(nullableRole.parse({ name: "a" })).toEqual({ name: "a" });
	});

	test("merges a union of objects into one object", () => {
		const outputSchema = outputSchemaFor(
			z.union([
				z.strictObject({
					type: z.literal("cron"),
					schedule: z.string(),
				}),
				z.strictObject({
					type: z.literal("storage"),
					bucket: z.string(),
				}),
			]),
		);
		expect(z.toJSONSchema(outputSchema)).toMatchObject({
			type: "object",
			required: ["type"],
		});
		expect(
			outputSchema.parse({ type: "cron", schedule: "* * * * *" }),
		).toEqual({ type: "cron", schedule: "* * * * *" });
		expect(() => outputSchema.parse({ type: "other" })).toThrow();
	});
});

describe("toStructuredContent", () => {
	test("returns an object as is and undefined as an empty object", () => {
		const data = { id: "p" };
		expect(toStructuredContent(data)).toBe(data);
		expect(toStructuredContent(undefined)).toEqual({});
	});
});

describe("credentials", () => {
	test("are optional and identifiable", () => {
		expect(isCredential(role.shape.password)).toBe(true);
		expect(isCredential(role.shape.name)).toBe(false);
		expect(role.parse({ name: "a" })).toEqual({ name: "a" });
		expect(role.parse({ name: "a", password: null })).toEqual({
			name: "a",
			password: null,
		});
	});

	test("withoutCredentials drops them at any depth and keeps the rest", () => {
		const outputSchema = outputSchemaFor(
			z.strictObject({
				role,
				roles: z.array(role).nullable(),
				byName: z.record(z.string(), role),
				connection: credential(z.string()),
			}),
		);
		const stripped = withoutCredentials(outputSchema);
		expect(z.toJSONSchema(stripped)).not.toHaveProperty(
			"properties.connection",
		);
		const json = JSON.stringify(z.toJSONSchema(stripped));
		expect(json).not.toContain("password");
		expect(json).toContain('"name"');
		expect(() =>
			stripped.parse({
				role: { name: "a" },
				roles: null,
				byName: {},
				x: 1,
			}),
		).toThrow();
		expect(
			stripped.parse({
				role: { name: "a", extra: 1 },
				roles: null,
				byName: {},
			}),
		).toEqual({ role: { name: "a", extra: 1 }, roles: null, byName: {} });
	});

	test("survive the wrapping of arrays, nullable objects, and unions", () => {
		const fromArray = withoutCredentials(outputSchemaFor(z.array(role)));
		expect(JSON.stringify(z.toJSONSchema(fromArray))).not.toContain(
			"password",
		);
		expect(
			JSON.stringify(z.toJSONSchema(outputDataSchema(fromArray))),
		).not.toContain("password");

		const nullable = outputSchemaFor(role.nullable());
		expect(isCredential(nullable.shape.password as z.ZodType)).toBe(true);

		const union = outputSchemaFor(
			z.union([
				z.looseObject({
					type: z.literal("a"),
					password: role.shape.password,
				}),
				z.looseObject({
					type: z.literal("b"),
					password: role.shape.password,
				}),
			]),
		);
		expect(isCredential(union.shape.password as z.ZodType)).toBe(true);
		expect(Object.keys(withoutCredentials(union).shape)).toEqual(["type"]);
	});

	test("withoutOutputFields drops fields by name", () => {
		const stripped = withoutOutputFields(outputSchemaFor(z.array(role)), [
			"password",
			"name",
		]);
		expect(z.toJSONSchema(stripped)).toMatchObject({
			properties: { items: { items: { properties: {} } } },
		});
	});
});
