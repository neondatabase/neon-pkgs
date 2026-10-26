import { describe, expect, test } from "vitest";
import { field, schema, table, v } from "../test-fixtures.js";
import { parseExportedSchema } from "./parse.js";

describe("parseExportedSchema", () => {
	test("parses a JSON string (as SchemaDefinition.export() returns)", () => {
		const json = JSON.stringify(
			schema([
				table({
					name: "messages",
					fields: { body: field(v.string()) },
				}),
			]),
		);
		const parsed = parseExportedSchema(json);
		expect(parsed.tables).toHaveLength(1);
		expect(parsed.tables[0].name).toBe("messages");
		expect(parsed.tables[0].columns).toEqual([
			{ name: "body", validator: { type: "string" }, optional: false },
		]);
		expect(parsed.schemaValidation).toBe(true);
	});

	test("accepts an already-parsed object", () => {
		const parsed = parseExportedSchema(
			schema([
				table({ name: "users", fields: { name: field(v.string()) } }),
			]),
		);
		expect(parsed.tables[0].name).toBe("users");
	});

	test("records optional flags per field", () => {
		const parsed = parseExportedSchema(
			schema([
				table({
					name: "users",
					fields: {
						name: field(v.string()),
						bio: field(v.string(), true),
					},
				}),
			]),
		);
		expect(parsed.tables[0].columns).toEqual([
			{ name: "name", validator: { type: "string" }, optional: false },
			{ name: "bio", validator: { type: "string" }, optional: true },
		]);
	});

	test("carries index definitions", () => {
		const parsed = parseExportedSchema(
			schema([
				table({
					name: "messages",
					fields: { authorId: field(v.id("users")) },
					indexes: [
						{ indexDescriptor: "by_author", fields: ["authorId"] },
					],
				}),
			]),
		);
		expect(parsed.tables[0].indexes).toEqual([
			{ indexDescriptor: "by_author", fields: ["authorId"] },
		]);
	});

	test("carries full search and vector index detail", () => {
		const parsed = parseExportedSchema(
			schema([
				table({
					name: "docs",
					fields: {
						body: field(v.string()),
						embedding: field(v.array(v.number())),
					},
					searchIndexes: [
						{
							indexDescriptor: "search_body",
							searchField: "body",
							filterFields: [],
						},
					],
					vectorIndexes: [
						{
							indexDescriptor: "by_embedding",
							vectorField: "embedding",
							dimensions: 1536,
							filterFields: ["cuisine"],
						},
					],
				}),
			]),
		);
		expect(parsed.tables[0].searchIndexes).toEqual([
			{ name: "search_body", searchField: "body", filterFields: [] },
		]);
		expect(parsed.tables[0].vectorIndexes).toEqual([
			{
				name: "by_embedding",
				vectorField: "embedding",
				dimensions: 1536,
				filterFields: ["cuisine"],
			},
		]);
	});

	test("defaults missing search/vector detail (descriptor-only entries)", () => {
		const parsed = parseExportedSchema(
			schema([
				table({
					name: "docs",
					fields: { body: field(v.string()) },
					searchIndexes: [{ indexDescriptor: "search_body" }],
					vectorIndexes: [{ indexDescriptor: "by_embedding" }],
				}),
			]),
		);
		expect(parsed.tables[0].searchIndexes).toEqual([
			{ name: "search_body", searchField: "", filterFields: [] },
		]);
		expect(parsed.tables[0].vectorIndexes).toEqual([
			{
				name: "by_embedding",
				vectorField: "",
				dimensions: 0,
				filterFields: [],
			},
		]);
	});

	test("marks a table with an `any` document type as schemaless", () => {
		const parsed = parseExportedSchema(
			schema([table({ name: "freeform", documentType: v.any() })]),
		);
		expect(parsed.tables[0].schemaless).toBe(true);
		expect(parsed.tables[0].columns).toEqual([]);
	});

	test("marks an empty object document type as schemaless", () => {
		const parsed = parseExportedSchema(
			schema([table({ name: "empty", fields: {} })]),
		);
		expect(parsed.tables[0].schemaless).toBe(true);
	});

	test("drops implicit _id / _creationTime if present in the document type", () => {
		const parsed = parseExportedSchema(
			schema([
				table({
					name: "messages",
					fields: {
						_id: field(v.id("messages")),
						_creationTime: field(v.number()),
						body: field(v.string()),
					},
				}),
			]),
		);
		expect(parsed.tables[0].columns.map((c) => c.name)).toEqual(["body"]);
	});

	test("throws on malformed input", () => {
		expect(() => parseExportedSchema("not json")).toThrow();
		expect(() => parseExportedSchema({ tables: "nope" } as never)).toThrow(
			/tables/,
		);
	});
});
