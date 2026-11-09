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
import {
	createNeonClient,
	NeonClientError,
	NeonNotFoundError,
} from "@neon/sdk";
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
			"user.organizations",
			"auth.getConfig",
			"resources.search",
			"resources.fetch",
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
		expect(data).toHaveProperty("logs_export");
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
		expect(Object.keys(data)).toEqual(["results"]);
		expect(data.results).toContainEqual({
			id: `project:${projectId}`,
			title: projectName,
			url: expect.stringContaining(`/app/projects/${projectId}`),
		});
		expect(data.results).toContainEqual({
			id: `branch:${projectId}/${plainBranchId}`,
			title: plainBranchName,
			url: expect.stringContaining(
				`/app/projects/${projectId}/branches/${plainBranchId}`,
			),
		});
	});

	it("resources.search matches ids", async () => {
		const { data } = await tools["resources.search"].execute({
			query: mainBranchId,
		});
		expect(data.results.map((result) => result.id)).toEqual([
			`branch:${projectId}/${mainBranchId}`,
		]);
	});

	it("resources.search and resources.fetch find a compute endpoint by id and by pooled host", async () => {
		const [endpoint] = await neon.postgres.endpoints.listByBranch({
			projectId,
			branchId: mainBranchId,
		});
		if (endpoint === undefined) throw new Error("main has no endpoint");
		const resultId = `endpoint:${projectId}/${endpoint.id}`;

		const byId = await tools["resources.search"].execute({
			query: endpoint.id.toUpperCase(),
		});
		expect(byId.data.results).toContainEqual({
			id: resultId,
			title: `${endpoint.id} (${endpoint.type})`,
			url: expect.stringContaining(
				`/app/projects/${projectId}/branches/${mainBranchId}`,
			),
		});

		const pooledHost = endpoint.host.replace(
			endpoint.id,
			`${endpoint.id}-pooler`,
		);
		const byHost = await tools["resources.search"].execute({
			query: pooledHost,
		});
		expect(byHost.data.results.map((result) => result.id)).toEqual([
			resultId,
		]);

		const { data } = await tools["resources.fetch"].execute({
			id: resultId,
		});
		expect(data).toMatchObject({
			id: resultId,
			title: `${endpoint.id} (${endpoint.type})`,
			metadata: { endpoint: { id: endpoint.id, host: endpoint.host } },
		});
		expect(data.text).toContain(`- Host: ${endpoint.host}`);
	});

	it("resources.search and resources.fetch find a snapshot by name", async () => {
		const snapshotName = `${projectName}-snap`;
		const snapshot = await neon.snapshots.create({
			projectId,
			branchId: mainBranchId,
			name: snapshotName,
		});
		const resultId = `snapshot:${projectId}/${snapshot.id}`;

		const { data: found } = await tools["resources.search"].execute({
			query: snapshotName,
		});
		expect(found.results).toContainEqual({
			id: resultId,
			title: snapshotName,
			url: expect.stringContaining(`/app/projects/${projectId}`),
		});

		const { data } = await tools["resources.fetch"].execute({
			id: resultId,
		});
		expect(data).toMatchObject({
			id: resultId,
			title: snapshotName,
			metadata: { snapshot: { id: snapshot.id, name: snapshotName } },
		});
	});

	it("resources.fetch returns an organization's details", async () => {
		const orgs = await neon.user.organizations();
		const org = orgs[0];
		if (org === undefined) throw new Error("The key sees no organization");
		const { data } = await tools["resources.fetch"].execute({
			id: `org:${org.id}`,
		});
		expect(data).toEqual({
			id: `org:${org.id}`,
			title: org.name,
			text: expect.stringContaining("**Organization Details**"),
			url: expect.stringContaining(`/app/${org.id}/projects`),
			metadata: expect.objectContaining({
				organization: expect.objectContaining({ id: org.id }),
			}),
		});
		expect(data.text).toContain(`- ID: ${org.id}`);
		const { metadata } = data;
		if (!("projects" in metadata))
			throw new Error("Not organization metadata");
		expect(data.text).toContain(`- Projects: ${metadata.projects.length}`);
		expect(metadata.projects.length).toBeGreaterThan(0);
	});

	it("resources.fetch returns a project's details and branches", async () => {
		const { data } = await tools["resources.fetch"].execute({
			id: `project:${projectId}`,
		});
		expect(data.id).toBe(`project:${projectId}`);
		expect(data.title).toBe(projectName);
		expect(data.url).toContain(`/app/projects/${projectId}`);
		expect(data.text).toContain("**Project Details**");
		expect(data.text).toContain("- Default Branch: main");
		const { metadata } = data;
		if (!("project" in metadata)) throw new Error("Not project metadata");
		expect(metadata.project.id).toBe(projectId);
		expect(metadata.branches.map((branch) => branch.id).sort()).toEqual(
			[mainBranchId, plainBranchId].sort(),
		);
	});

	it("resources.fetch describes a branch, including its database tree", async () => {
		const { data } = await tools["resources.fetch"].execute({
			id: `branch:${projectId}/${plainBranchId}`,
		});
		expect(data.id).toBe(`branch:${projectId}/${plainBranchId}`);
		expect(data.title).toBe(plainBranchName);
		expect(data.url).toContain(
			`/app/projects/${projectId}/branches/${plainBranchId}`,
		);
		expect(data.text).toContain("Branch Details:");
		expect(data.text).toContain("Database Structure:");
		const { metadata } = data;
		if (!("branch" in metadata)) throw new Error("Not branch metadata");
		expect(metadata.branch.id).toBe(plainBranchId);
		expect(JSON.stringify(metadata.database_structure)).toContain(
			"neondb (DATABASE)",
		);
	});

	it("resources.fetch rejects an id without a known prefix", async () => {
		const failure = tools["resources.fetch"].execute({ id: "nope:123" });
		await expect(failure).rejects.toBeInstanceOf(NeonClientError);
		await expect(failure).rejects.toThrow(
			'Invalid ID format: "nope:123". Expected format: org:*, project:*, branch:<project>/<branch>, endpoint:<project>/<endpoint>, or snapshot:<project>/<snapshot>',
		);
	});

	it("user.organizations returns and filters the organizations the key can access", async () => {
		const { data } = await tools["user.organizations"].execute({});
		const orgId = configuredOrgId();
		if (orgId !== undefined) {
			expect(data.map((org) => org.id)).toContain(orgId);
		}
		expect(data.length).toBeGreaterThan(0);
		const first = data[0];
		const { data: filtered } = await tools["user.organizations"].execute({
			search: first.id.slice(-6).toUpperCase(),
		});
		expect(filtered.map((org) => org.id)).toContain(first.id);
		const { data: none } = await tools["user.organizations"].execute({
			search: "no-organization-matches-this",
		});
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
				"fetch_resources",
				"get_config_auth",
				"organizations_user",
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
