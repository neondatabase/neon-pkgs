import { readFileSync } from "node:fs";
import { createNeonClient } from "@neon/sdk";
import { describe, expect, test } from "vitest";
import * as z from "zod";
import { createNeonTool, toolIds } from "./index.js";
import { operationFactories, operationIds } from "./operations.gen.js";
import {
	zCreateProjectBody,
	zCreateProjectBranchBody,
	zListProjectsQuery,
	zRestoreSnapshotQuery,
	zSetOrganizationSpendingLimitBody,
} from "./schemas.js";

interface OpenApiOperation {
	operationId?: string;
}

interface OpenApiDocument {
	paths: Record<string, Record<string, OpenApiOperation>>;
}

const document: OpenApiDocument = JSON.parse(
	readFileSync(
		new URL("../../sdk/spec/neon-openapi.json", import.meta.url),
		"utf8",
	),
);

const specOperationIds = Object.values(document.paths)
	.flatMap((path) => Object.values(path))
	.map((operation) => operation.operationId)
	.filter((operationId): operationId is string => operationId !== undefined)
	.sort();
const generatedSchemaSource = readFileSync(
	new URL("./generated/zod.gen.ts", import.meta.url),
	"utf8",
);

describe("generated operation coverage", () => {
	test("matches every operationId in the vendored OpenAPI document", () => {
		expect(operationIds).toHaveLength(169);
		expect([...operationIds].sort()).toEqual(specOperationIds);
	});

	test("generated factories still produce unique framework-safe ids", () => {
		const client = createNeonClient({ apiKey: "unused" }).client;
		const published = new Set<string>();

		for (const operationId of operationIds) {
			const tool = operationFactories[operationId](client);
			expect(tool.id).toMatch(/^[a-z0-9_]+$/);
			expect(published.has(tool.id)).toBe(false);
			published.add(tool.id);
			expect(z.toJSONSchema(tool.inputSchema).type).toBe("object");
		}
	});

	test("public tools have unique published ids and object schemas", () => {
		const published = new Set<string>();
		for (const id of toolIds) {
			const tool = createNeonTool(id, { apiKey: "test-key" });
			expect(tool.id).toMatch(/^[a-z0-9_]+$/);
			expect(published.has(tool.id)).toBe(false);
			published.add(tool.id);
			expect(z.toJSONSchema(tool.inputSchema).type).toBe("object");
		}
	});

	test("requires approval for mutations and treats logs.query as a read", () => {
		const deleteProject = createNeonTool("projects.delete", {
			apiKey: "test-key",
		});
		expect(deleteProject.annotations).toMatchObject({
			readOnlyHint: false,
			destructiveHint: true,
		});
		expect(deleteProject.requiresApproval).toBe(true);

		const logsQuery = createNeonTool("logs.query", { apiKey: "test-key" });
		expect(logsQuery.annotations.readOnlyHint).toBe(true);
		expect(logsQuery.annotations.destructiveHint).toBe(false);
		expect(logsQuery.requiresApproval).toBe(false);
		expect(logsQuery.description).toContain("every page");

		const roles = createNeonTool("postgres.roles.list", {
			apiKey: "test-key",
		});
		expect(roles.requiresApproval).toBe(false);
	});

	test("exports generated request schemas", () => {
		expect(zListProjectsQuery.parse({ limit: 1 })).toEqual({
			limit: 1,
		});
		expect(
			zListProjectsQuery.safeParse({ limit: 1, limti: 2 }).success,
		).toBe(false);
		expect(
			zCreateProjectBody.safeParse({
				project: { name: "demo", nmae: "typo" },
			}).success,
		).toBe(false);
		expect(
			zCreateProjectBranchBody.parse({
				branch: { name: "feature" },
				annotation_value: { commit: "abc123" },
			}),
		).toEqual({
			branch: { name: "feature" },
			annotation_value: { commit: "abc123" },
		});
		expect(
			zSetOrganizationSpendingLimitBody.safeParse({
				spending_limit_cents: 0,
			}).success,
		).toBe(false);
		expect(generatedSchemaSource).not.toContain(".default(");
		expect(zRestoreSnapshotQuery.parse({ name: "restored" })).toEqual({
			name: "restored",
		});
	});
});
