import { describe, expect, test } from "vitest";
import * as z from "zod";
import { compactJsonSchema, toMcpInputSchema } from "./mcp-json-schema.js";

describe("compactJsonSchema", () => {
	test("drops $schema and annotation descriptions, keeps a description field", () => {
		const schema = {
			$schema: "https://json-schema.org/draft/2020-12/schema",
			type: "object",
			description: "Create a record.",
			properties: {
				description: {
					type: "string",
					description:
						"Field help that should not appear on the wire.",
				},
				name: { type: "string", description: "Display name." },
			},
			required: ["description"],
			additionalProperties: false,
		};

		expect(compactJsonSchema(schema)).toEqual({
			type: "object",
			properties: {
				description: { type: "string" },
				name: { type: "string" },
			},
			required: ["description"],
			additionalProperties: false,
		});
	});

	test("keeps description keys under $defs and patternProperties", () => {
		const schema = {
			type: "object",
			$defs: {
				description: {
					type: "string",
					description: "unused",
				},
			},
			patternProperties: {
				description: { type: "number" },
			},
		};

		expect(compactJsonSchema(schema)).toEqual({
			type: "object",
			$defs: {
				description: { type: "string" },
			},
			patternProperties: {
				description: { type: "number" },
			},
		});
	});

	test("does not walk default, enum, or dependentRequired as schemas", () => {
		const schema = {
			type: "object",
			properties: {
				body: { type: "object" },
			},
			default: { description: "keep this default" },
			enum: [{ description: "keep this enum member" }],
			dependentRequired: { description: ["name"] },
		};

		expect(compactJsonSchema(schema)).toEqual({
			type: "object",
			properties: {
				body: { type: "object" },
			},
			default: { description: "keep this default" },
			enum: [{ description: "keep this enum member" }],
			dependentRequired: { description: ["name"] },
		});
	});
});

describe("toMcpInputSchema", () => {
	test("advertises compact JSON Schema and still validates", async () => {
		const schema = z.strictObject({
			limit: z.number().int(),
			description: z.string().optional(),
		});
		const mcpSchema = toMcpInputSchema(schema);
		const json = mcpSchema["~standard"].jsonSchema.input();

		expect(json).toMatchObject({
			type: "object",
			properties: {
				limit: { type: "integer" },
				description: { type: "string" },
			},
			required: ["limit"],
		});
		expect(json).not.toHaveProperty("$schema");
		expect(json).not.toHaveProperty("description");

		const valid = await mcpSchema["~standard"].validate({ limit: 1 });
		expect(valid).toMatchObject({ value: { limit: 1 } });

		const invalid = await mcpSchema["~standard"].validate({ limit: "one" });
		expect(invalid).toMatchObject({ issues: expect.any(Array) });
	});
});
