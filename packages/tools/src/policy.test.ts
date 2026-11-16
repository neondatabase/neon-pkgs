import { NeonClientError } from "@neon/sdk";
import { describe, expect, test } from "vitest";
import { createNeonTool, createNeonTools, toolIds } from "./index.js";

const READ_ONLY_SAFE = [
	"projects.list",
	"projects.count",
	"projects.get",
	"projects.permissions.list",
	"projects.members.list",
	"branches.list",
	"branches.get",
	"branches.getDefault",
	"branches.compareSchema",
	"postgres.endpoints.list",
	"postgres.endpoints.listByBranch",
	"postgres.endpoints.get",
	"postgres.roles.list",
	"postgres.roles.get",
	"postgres.databases.list",
	"postgres.databases.get",
	"postgres.dataApi.get",
	"storage.get",
	"storage.buckets.list",
	"storage.objects.list",
	"functions.list",
	"functions.get",
	"functions.customDomains.list",
	"triggers.list",
	"triggers.get",
	"credentials.list",
	"aiGateway.get",
	"realtime.get",
	"logs.query",
	"logs.fields",
	"logs.fieldValues",
	"logs.loki.queryRange",
	"snapshots.list",
	"snapshots.getSchedule",
	"operations.list",
	"operations.get",
	"auth.get",
	"auth.oauthServer.get",
	"auth.oauthClients.list",
	"auth.oauthClients.get",
	"auth.trustedDomains.list",
	"auth.allowLocalhost.get",
	"auth.emailAndPassword.get",
	"auth.emailProvider.get",
	"auth.plugins.get",
	"auth.plugins.phoneNumber.get",
	"auth.webhooks.get",
	"consumption.perProject",
	"consumption.perProjectV2",
	"consumption.perBranchV2",
	"apiKeys.list",
	"organizations.get",
	"organizations.members.list",
	"organizations.members.get",
	"organizations.invitations.list",
	"organizations.spendingLimit.get",
	"organizations.apiKeys.list",
	"regions.list",
	"user.me",
	"user.organizations",
	"incidents.list",
	"auth.getConfig",
	"resources.search",
	"sql.run",
	"sql.explain",
	"schema.listTables",
	"schema.describeTable",
	"branches.describe",
	"queries.listSlow",
	"database.inspect",
	"resources.fetch",
	"docs.search",
	"docs.get",
	"feedback.send",
];

const recordingFetch = () => {
	const requests: Request[] = [];
	const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
		requests.push(new Request(input, init));
		return new Response(JSON.stringify({ projects: [], pagination: {} }), {
			headers: { "content-type": "application/json" },
		});
	};
	return { requests, fetch };
};

describe("readOnlySafe", () => {
	test("is stated for every published tool", () => {
		const tools = createNeonTools({
			apiKey: "test-key",
			tools: () => true,
		});

		expect(Object.keys(tools)).toEqual([...toolIds]);
		const safe = Object.entries(tools)
			.filter(([, tool]) => tool?.metadata.readOnlySafe === true)
			.map(([id]) => id);
		expect(safe).toEqual(READ_ONLY_SAFE);
	});

	test("withholds the tools that hand out a connection string or run SQL outside one statement", () => {
		const tools = createNeonTools({
			apiKey: "test-key",
			tools: [
				"postgres.connectionString",
				"sql.runTransaction",
				"migrations.prepare",
				"queryTuning.prepare",
				"auth.oauthProviders.list",
			],
		});

		for (const tool of Object.values(tools)) {
			expect(tool.metadata.readOnlySafe).toBe(false);
		}
	});
});

describe("readOnly", () => {
	test("refuses a write tool before any request", async () => {
		const { requests, fetch } = recordingFetch();
		const tools = createNeonTools({
			apiKey: "test-key",
			tools: ["projects.delete", "projects.list"],
			fetch,
		});

		const refused = tools["projects.delete"].execute(
			{ project_id: "project-id" },
			{ readOnly: true },
		);
		await expect(refused).rejects.toBeInstanceOf(NeonClientError);
		await expect(refused).rejects.toThrow(
			"delete_projects is unavailable in read-only mode",
		);
		expect(requests).toHaveLength(0);

		await tools["projects.list"].execute({}, { readOnly: true });
		expect(requests).toHaveLength(1);
	});

	test("takes its default from the factory and lets a call override it", async () => {
		const { requests, fetch } = recordingFetch();
		const tools = createNeonTools({
			apiKey: "test-key",
			tools: ["projects.delete"],
			readOnly: true,
			fetch,
		});

		await expect(
			tools["projects.delete"].execute({ project_id: "project-id" }),
		).rejects.toBeInstanceOf(NeonClientError);
		expect(requests).toHaveLength(0);

		await tools["projects.delete"]
			.execute({ project_id: "project-id" }, { readOnly: false })
			.catch(() => undefined);
		expect(requests).toHaveLength(1);
		expect(requests[0].method).toBe("DELETE");
	});

	test("names the tool by its published name", async () => {
		const tools = createNeonTools({
			apiKey: "test-key",
			tools: ["sql.runTransaction"],
			names: { "sql.runTransaction": "run_sql_transaction" },
			readOnly: true,
		});

		await expect(
			tools["sql.runTransaction"].execute({
				project_id: "project-id",
				sql_statements: ["SELECT 1"],
			}),
		).rejects.toThrow(
			"run_sql_transaction is unavailable in read-only mode",
		);
	});

	test("applies to createNeonTool", async () => {
		const { requests, fetch } = recordingFetch();
		const deleteProject = createNeonTool("projects.delete", {
			apiKey: "test-key",
			readOnly: true,
			fetch,
		});

		await expect(
			deleteProject.execute({ project_id: "project-id" }),
		).rejects.toBeInstanceOf(NeonClientError);
		expect(requests).toHaveLength(0);
	});

	test("runs inside onExecute, so the hook sees the refusal", async () => {
		const outcomes: string[] = [];
		const tools = createNeonTools({
			apiKey: "test-key",
			tools: ["projects.delete"],
			readOnly: true,
			onExecute: async ({ id, execute }) => {
				try {
					return await execute();
				} catch (error) {
					outcomes.push(
						`${id}: ${error instanceof Error ? error.name : String(error)}`,
					);
					throw error;
				}
			},
		});

		await expect(
			tools["projects.delete"].execute({ project_id: "project-id" }),
		).rejects.toBeInstanceOf(NeonClientError);
		expect(outcomes).toEqual(["delete_projects: NeonClientError"]);
	});
});

describe("tools predicate", () => {
	test("selects the tools whose metadata matches, in catalog order", () => {
		const tools = createNeonTools({
			apiKey: "test-key",
			tools: (tool) =>
				tool.metadata.readOnlySafe &&
				tool.metadata.tags.includes("Snapshot"),
		});

		expect(Object.keys(tools)).toEqual([
			"snapshots.list",
			"snapshots.getSchedule",
		]);
	});

	test("sees each tool without its execute", () => {
		const seen: string[][] = [];
		createNeonTools({
			apiKey: "test-key",
			tools: (tool) => {
				seen.push(Object.keys(tool).sort());
				return tool.operationId === "projects.list";
			},
		});

		expect(seen).toHaveLength(toolIds.length);
		expect(seen[0]).toEqual([
			"annotations",
			"description",
			"id",
			"metadata",
			"operationId",
			"requiresApproval",
			"title",
		]);
	});

	test("composes with names", () => {
		const tools = createNeonTools({
			apiKey: "test-key",
			tools: (tool) => tool.operationId.startsWith("regions."),
			name: (id) => `neon_${id}`,
		});

		expect(tools["regions.list"]?.id).toBe("neon_list_regions");
	});

	test("throws when it matches no tool", () => {
		expect(() =>
			createNeonTools({ apiKey: "test-key", tools: () => false }),
		).toThrow("The createNeonTools tools predicate matched no tool");
	});
});
