import { describe, expect, test } from "vitest";

interface OutputGenerator {
	outputFor(operationId: string, operation: object): string;
	finish(entries: Array<[string, string]>): string;
}

type GenerateOutputSchemas = (
	document: object,
	dereference: (value: unknown) => unknown,
	options?: { credentials?: Record<string, string[]> },
) => OutputGenerator;

const generatorUrl = new URL("../scripts/output-schemas.mjs", import.meta.url);

const loadGenerator = async (): Promise<GenerateOutputSchemas> =>
	(await import(generatorUrl.href)).generateOutputSchemas;

const json = (schema: object) => ({
	description: "OK",
	content: { "application/json": { schema } },
});

const document = {
	components: {
		schemas: {
			Item: {
				type: "object",
				required: ["id", "status", "kind", "password"],
				properties: {
					id: { type: "string" },
					name: { type: "string", nullable: true },
					status: { type: "string", enum: ["ready", "init"] },
					kind: { type: "string", enum: ["item"] },
					count: { type: "integer", format: "int64", minimum: 0 },
					tags: { type: "array", items: { type: "string" } },
					labels: {
						type: "object",
						properties: { owner: { type: "string" } },
						additionalProperties: { type: "string" },
					},
					password: { type: "string" },
				},
			},
			Extended: {
				allOf: [
					{ $ref: "#/components/schemas/Item" },
					{
						type: "object",
						required: ["extra"],
						properties: { extra: { type: "boolean" } },
					},
				],
			},
			Other: {
				type: "object",
				properties: { other: { type: "number" } },
			},
			Choice: {
				oneOf: [
					{ $ref: "#/components/schemas/Item" },
					{ $ref: "#/components/schemas/Other" },
				],
			},
			Counts: {
				type: "object",
				additionalProperties: { type: "integer" },
			},
		},
	},
};

const operations = {
	getItem: {
		responses: { 200: json({ $ref: "#/components/schemas/Item" }) },
	},
	deleteItem: { responses: { 204: { description: "Deleted" } } },
	updateItem: {
		responses: {
			200: json({ $ref: "#/components/schemas/Extended" }),
			204: { description: "Unchanged" },
		},
	},
	downloadItem: {
		responses: {
			200: {
				description: "OK",
				content: {
					"application/octet-stream": {
						schema: { type: "string", format: "binary" },
					},
				},
			},
		},
	},
	listItems: {
		responses: {
			200: json({
				type: "object",
				required: ["items"],
				properties: {
					items: {
						type: "array",
						items: { $ref: "#/components/schemas/Choice" },
					},
					counts: { $ref: "#/components/schemas/Counts" },
				},
			}),
			default: json({ type: "object" }),
		},
	},
};

const generate = async (credentials: Record<string, string[]>) => {
	const generateOutputSchemas = await loadGenerator();
	const generator = generateOutputSchemas(document, (value) => value, {
		credentials,
	});
	const entries = Object.entries(operations).map(
		([operationId, operation]) =>
			[operationId, generator.outputFor(operationId, operation)] as [
				string,
				string,
			],
	);
	return generator.finish(entries);
};

describe("output schema codegen", () => {
	test("emits loose result schemas in dependency order", async () => {
		expect(await generate({ Item: ["password"] })).toMatchSnapshot();
	});

	test("fails when a listed credential field is never emitted", async () => {
		await expect(
			generate({ Item: ["password"], Other: ["secret"] }),
		).rejects.toThrow(
			"Credential fields not found in any response schema: Other.secret",
		);
	});
});
