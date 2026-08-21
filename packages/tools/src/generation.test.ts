import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import * as z from "zod";
import { createNeonTool, type NeonOperationId, operationIds } from "./index.js";
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
		expect(operationIds).toHaveLength(168);
		expect([...operationIds].sort()).toEqual(specOperationIds);
	});

	test("produces unique framework-safe ids and JSON schemas", () => {
		const toolIds = new Set<string>();

		for (const operationId of operationIds) {
			const tool = createNeonTool(operationId, { apiKey: "test-key" });
			expect(tool.id).toMatch(/^[a-z0-9_]+$/);
			expect(toolIds.has(tool.id)).toBe(false);
			toolIds.add(tool.id);
			expect(z.toJSONSchema(tool.inputSchema).type).toBe("object");
			const keys = Object.keys(
				z.toJSONSchema(tool.inputSchema).properties ?? {},
			);
			expect(keys).not.toContain("path");
			expect(keys).not.toContain("query");
			expect(keys).not.toContain("headers");
			if (
				operationId === "updateNeonAuthEmailProvider" ||
				operationId === "updateNeonAuthEmailServer"
			) {
				expect(keys).toContain("body");
			} else {
				expect(keys).not.toContain("body");
			}
		}

		const createProject = createNeonTool("createProject", {
			apiKey: "test-key",
		});
		expect(
			createProject.inputSchema.safeParse({ name: "demo" }).success,
		).toBe(true);
		expect(
			createProject.inputSchema.safeParse({
				project: { name: "demo" },
			}).success,
		).toBe(false);
	});

	test("requires approval for mutations and reads that return secrets", () => {
		const deleteProject = createNeonTool("deleteProject", {
			apiKey: "test-key",
		});
		expect(deleteProject.annotations).toMatchObject({
			readOnlyHint: false,
			destructiveHint: true,
		});
		expect(deleteProject.requiresApproval).toBe(true);
		expect(deleteProject.annotations.idempotentHint).toBeUndefined();

		const getConnectionUri = createNeonTool("getConnectionURI", {
			apiKey: "test-key",
		});
		expect(getConnectionUri.annotations.readOnlyHint).toBe(true);
		expect(getConnectionUri.annotations.idempotentHint).toBeUndefined();
		expect(getConnectionUri.requiresApproval).toBe(true);

		for (const operationId of [
			"getNeonAuthEmailProvider",
			"getNeonAuthEmailServer",
			"getNeonAuthPluginConfigs",
			"getProjectBranchRolePassword",
			"listBranchNeonAuthOauthProviders",
			"listNeonAuthOauthProviders",
		] as const) {
			const tool = createNeonTool(operationId, { apiKey: "test-key" });
			expect(tool.annotations.readOnlyHint).toBe(true);
			expect(tool.requiresApproval).toBe(true);
		}

		for (const operationId of [
			"getProjectBranchRole",
			"listProjectBranchRoles",
		] as const) {
			const tool = createNeonTool(operationId, { apiKey: "test-key" });
			expect(tool.requiresApproval).toBe(false);
		}
	});

	test("exports operation ids as a selector type", () => {
		const operationId: NeonOperationId = "listProjects";
		expect(operationId).toBe("listProjects");
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
