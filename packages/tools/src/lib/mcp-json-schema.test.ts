import { describe, expect, test } from "vitest";
import * as z from "zod";
import { toMcpInputSchema, toMcpJsonSchema } from "./mcp-json-schema.js";

describe("toMcpJsonSchema", () => {
	test("drops root $schema and keeps field descriptions", () => {
		const schema = z
			.strictObject({
				description: z.string().describe("Human-readable summary."),
				name: z.string().describe("Display name.").optional(),
			})
			.describe("Create a record.");

		expect(toMcpJsonSchema(schema)).toEqual({
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
		expect(toMcpJsonSchema(schema)).not.toHaveProperty("$schema");
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
});
