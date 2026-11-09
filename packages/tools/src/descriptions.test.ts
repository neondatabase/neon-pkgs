import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import * as z from "zod";
import { pathInputDescriptions, toolDescriptions } from "./descriptions.gen.js";
import { createNeonTool, createNeonTools, publishedId } from "./index.js";
import { toolFactories } from "./lib/ergonomic/catalog.js";
import { isNeonToolId, toolIds } from "./lib/ergonomic/ids.js";
import { resolveToolReferences, toolReferences } from "./lib/references.js";

const ALL_PAGES = " Returns every page. Pass limit to cap how many.";

const readJson = (file: string): unknown =>
	JSON.parse(readFileSync(new URL(file, import.meta.url), "utf8"));

const stringRecord = (value: unknown): Record<string, string> => {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new TypeError("Expected a JSON object");
	}
	const record: Record<string, string> = {};
	for (const [key, entry] of Object.entries(value)) {
		if (typeof entry !== "string") {
			throw new TypeError(`Expected a string for ${key}`);
		}
		record[key] = entry;
	}
	return record;
};

const toolDescriptionsJson = stringRecord(
	readJson("../scripts/tool-descriptions.json"),
);
const mcpToolNames = stringRecord(readJson("../scripts/mcp-tool-names.json"));

const defaultName = (selector: string) => {
	if (!isNeonToolId(selector)) throw new TypeError(selector);
	return publishedId(selector);
};

const inputDescription = (schema: z.ZodType, name: string) => {
	const property = z.toJSONSchema(schema, { io: "input" }).properties?.[name];
	return typeof property === "object" ? property.description : undefined;
};

describe("tool-descriptions.json", () => {
	test("names only published selectors and matches descriptions.gen.ts", () => {
		expect(
			Object.keys(toolDescriptionsJson).filter(
				(key) => !isNeonToolId(key),
			),
		).toEqual([]);
		expect(toolDescriptions).toEqual(toolDescriptionsJson);
	});

	test("every entry is the description its tool publishes", () => {
		const unused: string[] = [];
		for (const [selector, entry] of Object.entries(toolDescriptionsJson)) {
			if (!isNeonToolId(selector)) throw new TypeError(selector);
			const published = createNeonTool(selector, {
				apiKey: "test-key",
			}).description;
			const resolved = resolveToolReferences(
				entry,
				defaultName,
				selector,
			);
			if (
				published !== resolved &&
				published !== `${resolved}${ALL_PAGES}`
			) {
				unused.push(selector);
			}
		}
		expect(unused).toEqual([]);
	});
});

describe("tool references", () => {
	test("every built-in reference names a published tool", () => {
		const unknown: string[] = [];
		for (const id of toolIds) {
			const tool = toolFactories[id]({ apiKey: "test-key" });
			const text = `${tool.description} ${JSON.stringify(z.toJSONSchema(tool.inputSchema, { io: "input" }))}`;
			for (const selector of toolReferences(text)) {
				if (!isNeonToolId(selector)) unknown.push(`${id}: ${selector}`);
			}
		}
		expect(unknown).toEqual([]);
	});

	test("an unknown selector fails instead of publishing the token", () => {
		expect(() =>
			resolveToolReferences(
				"Use {{branches.lsit}}.",
				defaultName,
				"test",
			),
		).toThrow('Unknown Neon tool reference "{{branches.lsit}}" in test');
		expect(() =>
			resolveToolReferences(
				"Use {{operations.waitFor}}.",
				defaultName,
				"test",
			),
		).toThrow('Unknown Neon tool reference "{{operations.waitFor}}"');
		expect(() =>
			createNeonTools({
				apiKey: "test-key",
				tools: ["projects.list"] as const,
				descriptions: { "projects.list": "See {{projects.nope}}." },
			}),
		).toThrow(
			'Unknown Neon tool reference "{{projects.nope}}" in the description of projects.list',
		);
	});

	test("published descriptions and input schemas carry no tokens", () => {
		const tools = createNeonTools({ apiKey: "test-key", tools: toolIds });
		for (const id of toolIds) {
			const tool = tools[id];
			expect(tool.description, id).not.toContain("{{");
			expect(
				JSON.stringify(
					z.toJSONSchema(tool.inputSchema, { io: "input" }),
				),
				id,
			).not.toContain("{{");
		}
	});

	test("resolve to the default published id", () => {
		expect(
			createNeonTool("projects.create", { apiKey: "test-key" })
				.description,
		).toBe(
			"Creates a project with a default branch and read-write compute and waits until it is ready. Returns no connection string; use connection_string_postgres.",
		);
	});

	test("follow names and name, including for tools that are not selected", () => {
		const tools = createNeonTools({
			apiKey: "test-key",
			tools: [
				"projects.create",
				"postgres.connectionString",
				"migrations.complete",
				"migrations.prepare",
				"branches.get",
			] as const,
			names: {
				"postgres.connectionString": "get_connection_string",
				"migrations.prepare": "prepare_database_migration",
			},
			name: (id) => `neon_${id}`,
		});
		expect(tools["projects.create"].description).toBe(
			"Creates a project with a default branch and read-write compute and waits until it is ready. Returns no connection string; use neon_get_connection_string.",
		);
		expect(
			inputDescription(
				tools["migrations.complete"].inputSchema,
				"migration_id",
			),
		).toBe("The migration_id from neon_prepare_database_migration.");
		expect(tools["branches.get"].description).toContain(
			"use neon_describe_branches.",
		);
	});

	test("resolve in host descriptions, and the description function sees resolved text", () => {
		const seen: string[] = [];
		const tools = createNeonTools({
			apiKey: "test-key",
			tools: ["projects.list", "branches.list"] as const,
			names: { "branches.list": "list_branches" },
			descriptions: (tool) => {
				seen.push(tool.description);
				return tool.id === "list_projects"
					? "List projects, then {{branches.list}}."
					: tool.description;
			},
		});
		expect(tools["projects.list"].description).toBe(
			"List projects, then list_branches.",
		);
		expect(seen.join(" ")).not.toContain("{{");
		expect(seen[0]).toContain("search_resources");
	});

	test("keep input validation when an input description is resolved", () => {
		const tool = createNeonTool("migrations.complete", {
			apiKey: "test-key",
		});
		expect(inputDescription(tool.inputSchema, "migration_id")).toBe(
			"The migration_id from prepare_migrations.",
		);
		const input = {
			migration_id: "m",
			migration_sql: "SELECT 1",
			database_name: "neondb",
			project_id: "p",
			temporary_branch_id: "br-t",
			parent_branch_id: "br-p",
		};
		expect(tool.inputSchema.safeParse(input).success).toBe(true);
		expect(
			tool.inputSchema.safeParse({ ...input, extra: true }).success,
		).toBe(false);
		expect(
			tool.inputSchema.safeParse({ ...input, migration_id: undefined })
				.success,
		).toBe(false);
	});
});

describe("path parameter descriptions", () => {
	test("every branch_id input says it takes an id, not a name", () => {
		const mismatched: string[] = [];
		for (const id of toolIds) {
			const tool = createNeonTool(id, { apiKey: "test-key" });
			const description = inputDescription(tool.inputSchema, "branch_id");
			const inPath = tool.metadata.path.includes("{branch_id}");
			if (
				description === undefined ||
				(!inPath && id.startsWith("postgres.endpoints."))
			) {
				continue;
			}
			if (!description.startsWith(pathInputDescriptions.branch_id)) {
				mismatched.push(`${id}: ${description}`);
			}
		}
		expect(mismatched).toEqual([]);
	});

	test("tool descriptions do not repeat the branch_id note", () => {
		for (const id of toolIds) {
			expect(
				createNeonTool(id, { apiKey: "test-key" }).description,
				id,
			).not.toContain("not a name");
		}
	});
});

describe("mcp-tool-names.json", () => {
	const selectors = Object.values(mcpToolNames);

	test("maps each of the Neon MCP server's 139 tools to a distinct published selector", () => {
		expect(Object.keys(mcpToolNames)).toHaveLength(139);
		expect(new Set(selectors).size).toBe(selectors.length);
		expect(selectors.filter((selector) => !isNeonToolId(selector))).toEqual(
			[],
		);
	});

	test("publishes the MCP names and resolves references to them", () => {
		const tools = selectors.filter(isNeonToolId);
		const names = Object.fromEntries(
			Object.entries(mcpToolNames).map(([name, selector]) => [
				selector,
				name,
			]),
		);
		const created = createNeonTools({ apiKey: "test-key", tools, names });
		const byName = new Map(
			Object.values(created).map((tool) => [tool.id, tool]),
		);
		expect([...byName.keys()].sort()).toEqual(
			Object.keys(mcpToolNames).sort(),
		);
		expect(byName.get("create_project")?.description).toContain(
			"use get_connection_string.",
		);
		expect(byName.get("get_branch")?.description).toContain(
			"use describe_branch.",
		);
		expect(byName.get("describe_branch")?.description).toContain(
			"Branch record only: get_branch;",
		);
		expect(byName.get("get_auth")?.description).toContain(
			"Prefer get_neon_auth_config, which adds the auth settings",
		);
		expect(byName.get("list_postgres_endpoints")?.description).toContain(
			"use list_branch_computes.",
		);
		expect(byName.get("list_branch_computes")?.description).toContain(
			"use list_postgres_endpoints.",
		);
	});

	test("the MCP tools only reference other MCP tools", () => {
		const published = new Set(selectors);
		const outside: string[] = [];
		for (const selector of selectors.filter(isNeonToolId)) {
			const tool = toolFactories[selector]({ apiKey: "test-key" });
			const text = `${tool.description} ${JSON.stringify(z.toJSONSchema(tool.inputSchema, { io: "input" }))}`;
			for (const reference of toolReferences(text)) {
				if (!published.has(reference)) {
					outside.push(`${selector} -> ${reference}`);
				}
			}
		}
		expect(outside).toEqual([]);
	});
});

describe("README", () => {
	test("the Descriptions example prints what it says", () => {
		const tools = createNeonTools({
			apiKey: "test-key",
			tools: [
				"projects.create",
				"postgres.connectionString",
				"projects.delete",
			] as const,
			names: { "postgres.connectionString": "get_connection_string" },
			descriptions: {
				"postgres.connectionString":
					"Get a connection string. Call it after {{projects.create}}.",
				delete_projects:
					"Delete a Neon project and all its data. NEVER run autonomously; always ask the user first.",
			},
		});
		expect(tools["projects.create"].description).toBe(
			"Creates a project with a default branch and read-write compute and waits until it is ready. Returns no connection string; use get_connection_string.",
		);
		expect(tools["postgres.connectionString"].description).toBe(
			"Get a connection string. Call it after create_projects.",
		);
	});
});
