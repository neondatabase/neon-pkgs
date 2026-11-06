import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import {
	configuredBaseUrl,
	configuredOrgId,
	createProject,
	deleteProject,
	requireApiKey,
	uniqueProjectName,
} from "@neon/e2e-harness";
import { enableNeonAuth } from "@neon/e2e-harness/auth";
import { createNeonClient, NeonNotFoundError } from "@neon/sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createNeonTools } from "../src/index.js";
import { registerNeonTools } from "../src/mcp.js";

const OAUTH_SECRET = "e2e-oauth-client-secret-value";
const SMTP_PASSWORD = "e2e-smtp-password-value";

/**
 * The custom tools against one project: Neon Auth enabled on the default branch with a
 * Google provider and an SMTP server that carry real secret values, and a second branch
 * created before Neon Auth (a later branch inherits it) for the not-found path.
 */
describe.sequential("e2e — @neon/tools custom tools", () => {
	const neon = createNeonClient({
		apiKey: requireApiKey(),
		baseUrl: configuredBaseUrl(),
		throwOnError: true,
	});
	const tools = createNeonTools({
		apiKey: requireApiKey(),
		baseUrl: configuredBaseUrl(),
		tools: [
			"organizations.listAccessible",
			"auth.getConfig",
			"resources.search",
		],
	});
	const projectName = uniqueProjectName("tools-custom");
	let projectId: string;
	let mainBranchId: string;
	let plainBranchId: string;
	const plainBranchName = `${projectName}-plain`;

	beforeAll(async () => {
		projectId = await createProject({ name: projectName });
		const main = await neon.branches.getDefault({ projectId });
		mainBranchId = main.id;
		const plain = await neon.branches.create({
			projectId,
			name: plainBranchName,
		});
		plainBranchId = plain.id;
		await enableNeonAuth(projectId, mainBranchId);
		const ids = { projectId, branchId: mainBranchId };
		await neon.auth.oauthProviders.update({
			...ids,
			providerId: "google",
			client_id: "e2e-client-id",
			client_secret: OAUTH_SECRET,
		});
		await neon.auth.emailProvider.update({
			...ids,
			type: "standard",
			host: "smtp.example.com",
			port: 587,
			username: "e2e-user",
			password: SMTP_PASSWORD,
			sender_email: "e2e@example.com",
			sender_name: "E2E",
		});
	});

	afterAll(async () => {
		if (projectId) await deleteProject(projectId);
	});

	it("auth.getConfig reads the default branch and redacts secrets", async () => {
		const { data } = await tools["auth.getConfig"].execute({
			project_id: projectId,
		});
		expect(data.branch_id).toBe(mainBranchId);
		expect(data.branch_name).toBe("main");
		expect(data.integration.auth_provider).toBe("better_auth");
		expect(data.auth_methods.email_password?.allow_sign_up).toBe(true);
		expect(data.oauth_providers).toContainEqual({
			id: "google",
			type: "standard",
			client_id: "e2e-client-id",
			client_secret: "***redacted***",
		});
		expect(data.email_provider).toEqual({
			type: "standard",
			host: "smtp.example.com",
			port: 587,
			username: "e2e-user",
			password: "***redacted***",
			sender_email: "e2e@example.com",
			sender_name: "E2E",
		});
		expect(data).not.toHaveProperty("_errors");
		const serialized = JSON.stringify(data);
		expect(serialized).not.toContain(OAUTH_SECRET);
		expect(serialized).not.toContain(SMTP_PASSWORD);
	});

	it("auth.getConfig throws NeonNotFoundError for a branch without Neon Auth", async () => {
		await expect(
			tools["auth.getConfig"].execute({
				project_id: projectId,
				branch_id: plainBranchId,
			}),
		).rejects.toBeInstanceOf(NeonNotFoundError);
	});

	it("resources.search finds the project and its branches by name", async () => {
		const { data } = await tools["resources.search"].execute({
			query: projectName.toUpperCase(),
		});
		expect(data).toContainEqual({
			id: `project:${projectId}`,
			title: projectName,
			url: expect.stringContaining(`/app/projects/${projectId}`),
			type: "project",
		});
		expect(data).toContainEqual({
			id: `branch:${projectId}/${plainBranchId}`,
			title: plainBranchName,
			url: expect.stringContaining(
				`/app/projects/${projectId}/branches/${plainBranchId}`,
			),
			type: "branch",
		});
	});

	it("resources.search matches ids", async () => {
		const { data } = await tools["resources.search"].execute({
			query: mainBranchId,
		});
		expect(data.map((result) => result.id)).toEqual([
			`branch:${projectId}/${mainBranchId}`,
		]);
	});

	it("organizations.listAccessible returns the organization the key can access", async () => {
		const { data } = await tools["organizations.listAccessible"].execute(
			{},
		);
		const orgId = configuredOrgId();
		if (orgId !== undefined) {
			expect(data.map((org) => org.id)).toContain(orgId);
		}
		expect(data.length).toBeGreaterThan(0);
		const first = data[0];
		const { data: filtered } = await tools[
			"organizations.listAccessible"
		].execute({ search: first.id.slice(-6).toUpperCase() });
		expect(filtered.map((org) => org.id)).toContain(first.id);
		const { data: none } = await tools[
			"organizations.listAccessible"
		].execute({ search: "no-organization-matches-this" });
		expect(none).toEqual([]);
	});

	it("the custom tools work over MCP", async () => {
		const server = new McpServer({ name: "e2e", version: "1.0.0" });
		registerNeonTools(server, tools);
		const client = new Client({ name: "e2e-client", version: "1.0.0" });
		const [clientTransport, serverTransport] =
			InMemoryTransport.createLinkedPair();
		await Promise.all([
			server.connect(serverTransport),
			client.connect(clientTransport),
		]);
		try {
			const listed = await client.listTools();
			expect(listed.tools.map((tool) => tool.name).sort()).toEqual([
				"get_config_auth",
				"list_accessible_organizations",
				"search_resources",
			]);
			const called = await client.callTool({
				name: "get_config_auth",
				arguments: { project_id: projectId, branch_id: mainBranchId },
			});
			expect(called.isError).not.toBe(true);
			const text = JSON.stringify(called.structuredContent);
			expect(text).toContain("***redacted***");
			expect(text).not.toContain(OAUTH_SECRET);
			expect(text).not.toContain(SMTP_PASSWORD);
		} finally {
			await client.close();
			await server.close();
		}
	});
});
