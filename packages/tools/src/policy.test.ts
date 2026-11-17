import { NeonClientError, NeonNetworkError } from "@neon/sdk";
import { describe, expect, test } from "vitest";
import {
	createNeonTool,
	createNeonTools,
	type NeonSecretsMode,
	toolIds,
	withheldUnderSecrets,
} from "./index.js";
import { redactSecretFields } from "./lib/redact.js";

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

// fetch refuses this port, so a call that gets past the policy fails with
// NeonNetworkError and a refused one with NeonClientError.
const NO_NEON_API = "http://127.0.0.1:1/api/v2";

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
	test("refuses a write tool before any request and lets a read tool through", async () => {
		const tools = createNeonTools({
			apiKey: "test-key",
			tools: ["projects.delete", "projects.list"],
			baseUrl: NO_NEON_API,
		});

		const refused = tools["projects.delete"].execute(
			{ project_id: "project-id" },
			{ readOnly: true },
		);
		await expect(refused).rejects.toBeInstanceOf(NeonClientError);
		await expect(refused).rejects.toThrow(
			"delete_projects is unavailable in read-only mode",
		);
		await expect(
			tools["projects.list"].execute({}, { readOnly: true }),
		).rejects.toBeInstanceOf(NeonNetworkError);
	});

	test("takes its default from the factory and lets a call override it", async () => {
		const tools = createNeonTools({
			apiKey: "test-key",
			tools: ["projects.delete"],
			readOnly: true,
			baseUrl: NO_NEON_API,
		});

		await expect(
			tools["projects.delete"].execute({ project_id: "project-id" }),
		).rejects.toThrow("delete_projects is unavailable in read-only mode");
		await expect(
			tools["projects.delete"].execute(
				{ project_id: "project-id" },
				{ readOnly: false },
			),
		).rejects.toBeInstanceOf(NeonNetworkError);
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
		const deleteProject = createNeonTool("projects.delete", {
			apiKey: "test-key",
			readOnly: true,
			baseUrl: NO_NEON_API,
		});

		await expect(
			deleteProject.execute({ project_id: "project-id" }),
		).rejects.toThrow("delete_projects is unavailable in read-only mode");
	});

	test("refuses before an injected id resolves", async () => {
		const resolved: string[] = [];
		const deleteProject = createNeonTool("projects.delete", {
			apiKey: "test-key",
			readOnly: true,
			inject: {
				projectId: async () => {
					resolved.push("projectId");
					throw new Error("project lookup failed");
				},
				omitFromSchema: true,
			},
		});

		await expect(deleteProject.execute({})).rejects.toThrow(
			"delete_projects is unavailable in read-only mode",
		);
		expect(resolved).toEqual([]);
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

const SECRET_OUTPUT_FIELDS = {
	"projects.createAndConnect": ["setup $.connectionString"],
	"branches.createAndConnect": ["setup $.connectionString"],
	"postgres.connectionString": ["setup $"],
	"postgres.roles.list": ["setup $[*].password"],
	"postgres.roles.get": ["setup $.password"],
	"postgres.roles.create": ["setup $.password"],
	"postgres.roles.resetPassword": ["setup $.password"],
	"storage.objects.presign": ["setup $.url"],
	"credentials.create": ["setup $.api_token", "setup $.s3_secret_access_key"],
	"credentials.rotate": ["setup $.api_token", "setup $.s3_secret_access_key"],
	"realtime.secret": ["setup $.secret"],
	"auth.create": ["setup $.secret_server_key"],
	"auth.oauthProviders.list": ["stored $[*].client_secret"],
	"auth.oauthProviders.add": ["stored $.client_secret"],
	"auth.oauthProviders.update": ["stored $.client_secret"],
	"auth.oauthClients.create": ["setup $.client_secret"],
	"auth.oauthClients.rotateSecret": ["setup $.client_secret"],
	"auth.emailProvider.get": ["stored $.password"],
	"auth.emailProvider.update": ["stored $.password"],
	"auth.plugins.get": [
		"stored $.email_provider.password",
		"stored $.oauth_providers[*].client_secret",
	],
	"apiKeys.create": ["setup $.key"],
	"organizations.apiKeys.create": ["setup $.key"],
	"auth.getConfig": [
		"stored $.oauth_providers[*].client_secret",
		"stored $.email_provider.password",
	],
};

const RETURNS_ONLY_SECRETS = [
	"postgres.connectionString",
	"postgres.roles.resetPassword",
	"storage.objects.presign",
	"credentials.rotate",
	"realtime.secret",
	"auth.oauthClients.rotateSecret",
];

const allTools = () =>
	Object.entries(createNeonTools({ apiKey: "test-key", tools: () => true }));

describe("secret metadata", () => {
	test("lists the secret fields of every tool that returns one", () => {
		const declared = Object.fromEntries(
			allTools()
				.filter(
					([, tool]) =>
						(tool?.metadata.secretOutputFields.length ?? 0) > 0,
				)
				.map(([id, tool]) => [
					id,
					tool?.metadata.secretOutputFields.map(
						(field) => `${field.kind} ${field.path}`,
					),
				]),
		);
		expect(declared).toEqual(SECRET_OUTPUT_FIELDS);
		const only = allTools()
			.filter(([, tool]) => tool?.metadata.returnsOnlySecrets === true)
			.map(([id]) => id);
		expect(only).toEqual(RETURNS_ONLY_SECRETS);
	});

	test("every secret path parses", () => {
		for (const [, tool] of allTools()) {
			const paths = tool?.metadata.secretOutputFields.map(
				(field) => field.path,
			);
			expect(() =>
				redactSecretFields(undefined, paths ?? []),
			).not.toThrow();
		}
	});

	test("only none withholds tools, because every secret-only result is setup", () => {
		const withheld = (mode: NeonSecretsMode) =>
			allTools()
				.filter(
					([, tool]) =>
						tool !== undefined &&
						withheldUnderSecrets(tool.metadata, mode),
				)
				.map(([id]) => id);

		expect(withheld("all")).toEqual([]);
		expect(withheld("setup")).toEqual([]);
		expect(withheld("none")).toEqual(RETURNS_ONLY_SECRETS);
	});
});

describe("secrets", () => {
	test("none refuses a tool whose result is the secret before any request", async () => {
		const tools = createNeonTools({
			apiKey: "test-key",
			tools: ["realtime.secret", "credentials.list"],
			secrets: "none",
			baseUrl: NO_NEON_API,
		});
		const ids = { project_id: "project-id", branch_id: "branch-id" };

		const refused = tools["realtime.secret"].execute(ids);
		await expect(refused).rejects.toBeInstanceOf(NeonClientError);
		await expect(refused).rejects.toThrow(
			'secret_realtime is unavailable with secrets: "none" because its result is a secret.',
		);
		await expect(
			tools["credentials.list"].execute(ids),
		).rejects.toBeInstanceOf(NeonNetworkError);
		await expect(
			tools["realtime.secret"].execute(ids, { secrets: "setup" }),
		).rejects.toBeInstanceOf(NeonNetworkError);
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
