import { describe, expect, test } from "vitest";
import * as z from "zod";
import {
	compactJsonSchema,
	toMcpInputSchema,
	toMcpOutputJsonSchema,
	toMcpOutputSchema,
} from "./mcp-json-schema.js";

describe("compactJsonSchema", () => {
	test("drops root $schema and keeps field descriptions", () => {
		const schema = {
			$schema: "https://json-schema.org/draft/2020-12/schema",
			type: "object",
			description: "Create a record.",
			properties: {
				description: {
					type: "string",
					description: "Human-readable summary.",
				},
				name: { type: "string", description: "Display name." },
			},
			required: ["description"],
			additionalProperties: false,
		};

		expect(compactJsonSchema(schema)).toEqual({
			type: "object",
			description: "Create a record.",
			properties: {
				description: {
					type: "string",
					description: "Human-readable summary.",
				},
				name: { type: "string", description: "Display name." },
			},
			required: ["description"],
			additionalProperties: false,
		});
	});
});

describe("toMcpInputSchema", () => {
	test("advertises compact JSON Schema and still validates", async () => {
		const schema = z.strictObject({
			limit: z.number().int(),
			description: z
				.string()
				.describe("Human-readable summary.")
				.optional(),
		});
		const mcpSchema = toMcpInputSchema(schema);
		const json = mcpSchema["~standard"].jsonSchema.input();

		expect(json).toMatchObject({
			type: "object",
			properties: {
				limit: { type: "integer" },
				description: {
					type: "string",
					description: "Human-readable summary.",
				},
			},
			required: ["limit"],
		});
		expect(json).not.toHaveProperty("$schema");

		const valid = await mcpSchema["~standard"].validate({ limit: 1 });
		expect(valid).toMatchObject({ value: { limit: 1 } });

		const invalid = await mcpSchema["~standard"].validate({ limit: "one" });
		expect(invalid).toMatchObject({ issues: expect.any(Array) });
	});

	test("publishes Z$ for Zod's default datetime pattern and validates the full format", async () => {
		const schema = z.strictObject({
			expires_at: z.iso.datetime().optional(),
			nested: z
				.strictObject({ at: z.iso.datetime().nullable() })
				.optional(),
			with_offset: z.iso.datetime({ offset: true }).optional(),
			custom: z.string().regex(/^a+$/).optional(),
		});
		const mcpSchema = toMcpInputSchema(schema);
		const json = mcpSchema["~standard"].jsonSchema.input();
		const raw = z.toJSONSchema(schema, { io: "input" }) as {
			properties: Record<string, unknown>;
		};

		expect(json).toMatchObject({
			properties: {
				expires_at: {
					type: "string",
					format: "date-time",
					pattern: "Z$",
				},
				nested: {
					properties: {
						at: {
							anyOf: [
								{
									type: "string",
									format: "date-time",
									pattern: "Z$",
								},
								{ type: "null" },
							],
						},
					},
				},
				with_offset: raw.properties.with_offset,
				custom: raw.properties.custom,
			},
		});

		for (const expires_at of [
			"2026-02-30T00:00:00Z",
			"2026-01-01T00:00:00-08:00",
			"tomorrow",
		]) {
			expect(
				await mcpSchema["~standard"].validate({ expires_at }),
			).toMatchObject({ issues: expect.any(Array) });
		}
		expect(
			await mcpSchema["~standard"].validate({
				expires_at: "2026-01-01T00:00:00Z",
			}),
		).toMatchObject({ value: { expires_at: "2026-01-01T00:00:00Z" } });
	});

	test("leaves inputs named format or pattern and datetime defaults alone", () => {
		const at = "2026-01-01T00:00:00Z";
		const schema = z.strictObject({
			format: z.string().default("date-time"),
			pattern: z.string().optional(),
			since: z.iso.datetime().default(at),
		});
		const json = toMcpInputSchema(schema)["~standard"].jsonSchema.input();

		expect(json).toMatchObject({
			properties: {
				format: { type: "string", default: "date-time" },
				pattern: { type: "string" },
				since: {
					type: "string",
					format: "date-time",
					pattern: "Z$",
					default: at,
				},
			},
		});
	});

	test("Zod's default datetime pattern only accepts a Z offset", () => {
		const pattern = z.toJSONSchema(z.iso.datetime()).pattern;
		expect(pattern).toEqual(expect.any(String));
		const regex = new RegExp(pattern as string);
		expect(regex.test("2026-01-01T00:00:00Z")).toBe(true);
		expect(regex.test("2026-01-01T00:00:00.123Z")).toBe(true);
		expect(regex.test("2026-01-01T00:00:00+01:00")).toBe(false);
		expect(regex.test("2026-01-01T00:00:00")).toBe(false);
	});
});

describe("toMcpOutputJsonSchema", () => {
	const branch = z.looseObject({
		id: z.string().describe("Branch id."),
		parent_id: z.string().describe("Parent branch id.").nullish(),
		settings: z
			.looseObject({ ttl: z.number().min(0), owner: z.string() })
			.nullish(),
	});

	test("wraps data and types its fields, one level deep", () => {
		expect(toMcpOutputJsonSchema(z.array(branch))).toEqual({
			type: "object",
			properties: {
				data: {
					type: "array",
					items: {
						type: "object",
						properties: {
							id: { type: "string", description: "Branch id." },
							parent_id: {
								type: ["string", "null"],
								description: "Parent branch id.",
							},
							settings: { type: ["object", "null"] },
						},
						required: ["id"],
					},
				},
			},
			required: ["data"],
		});
	});

	test("omits fields the host strips, at every level", () => {
		const connection = z.looseObject({
			branch: branch.extend({ password: z.string() }),
			connectionString: z.string(),
		});
		expect(
			toMcpOutputJsonSchema(z.array(connection), {
				omit: ["connectionString", "password"],
			}).properties,
		).toEqual({
			data: {
				type: "array",
				items: {
					type: "object",
					properties: { branch: { type: "object" } },
					required: ["branch"],
				},
			},
		});
		expect(
			toMcpOutputJsonSchema(branch.extend({ password: z.string() }), {
				omit: ["password"],
			}),
		).toEqual(toMcpOutputJsonSchema(branch));
	});

	test("keeps unions of objects and scalar data", () => {
		expect(
			toMcpOutputJsonSchema(
				z.union([
					z.looseObject({ a: z.string() }),
					z.looseObject({ b: z.number() }),
				]),
			).properties,
		).toEqual({
			data: {
				anyOf: [
					{
						type: "object",
						properties: { a: { type: "string" } },
						required: ["a"],
					},
					{
						type: "object",
						properties: { b: { type: "number" } },
						required: ["b"],
					},
				],
			},
		});
		expect(toMcpOutputJsonSchema(z.null()).properties).toEqual({
			data: { type: "null" },
		});
	});
});

describe("toMcpOutputSchema", () => {
	const mcpSchema = toMcpOutputSchema(
		z.looseObject({
			id: z.string(),
			settings: z.looseObject({ ttl: z.number() }),
		}),
	);

	test("accepts fields the schema does not list and returns content unchanged", async () => {
		const content = {
			data: {
				id: "br-1",
				settings: { ttl: "deep values are not checked" },
				extra: 1,
			},
		};
		expect(await mcpSchema["~standard"].validate(content)).toEqual({
			value: content,
		});
	});

	test("rejects a missing or mistyped top-level field", async () => {
		expect(
			await mcpSchema["~standard"].validate({ data: { settings: {} } }),
		).toMatchObject({ issues: expect.any(Array) });
		expect(
			await mcpSchema["~standard"].validate({
				data: { id: 1, settings: {} },
			}),
		).toMatchObject({ issues: expect.any(Array) });
	});
});
