import { describe, expect, it } from "vitest";
import { createNeonClient } from "../client.js";

/** Real ergonomic client whose only stub is the network boundary. */
function neonReturning(status: number, body: unknown) {
	return createNeonClient({
		apiKey: "test",
		retries: 0,
		fetch: async () =>
			new Response(body === undefined ? null : JSON.stringify(body), {
				status,
				headers: { "content-type": "application/json" },
			}),
	});
}

describe("phase-1 namespaces map responses to the ergonomic shape", () => {
	it("auth.get unwraps the integration body", async () => {
		const neon = neonReturning(200, {
			branch_id: "br-1",
			db_name: "neondb",
		});
		const { data, error } = await neon.auth.get({
			projectId: "p-1",
			branchId: "br-1",
		});
		expect(error).toBeUndefined();
		expect(data?.branch_id).toBe("br-1");
	});

	it("auth.oauthProviders.list unwraps the providers array", async () => {
		const neon = neonReturning(200, { providers: [{ id: "google" }] });
		const { data } = await neon.auth.oauthProviders.list({
			projectId: "p-1",
			branchId: "br-1",
		});
		expect(data).toEqual([{ id: "google" }]);
	});

	it("auth.oauthServer.get and update hit the oauth-provider plugin path", async () => {
		const requests: Request[] = [];
		const serverConfig = {
			enabled: false,
			login_page: "https://login.example.com",
			mcp: { resource: "https://mcp-get.example.com" },
		};
		const updatedConfig = {
			enabled: true,
			login_page: "https://login.example.com",
			mcp: { resource: "https://mcp.example.com" },
		};
		const responses = [serverConfig, updatedConfig];
		let call = 0;
		const neon = createNeonClient({
			apiKey: "test",
			retries: 0,
			fetch: async (input, init) => {
				requests.push(new Request(input, init));
				return new Response(JSON.stringify(responses[call++] ?? {}), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			},
		});
		const got = await neon.auth.oauthServer.get({
			projectId: "p-1",
			branchId: "br-1",
		});
		expect(got.data).toEqual(serverConfig);
		const updated = await neon.auth.oauthServer.update({
			projectId: "p-1",
			branchId: "br-1",
			enabled: true,
			mcp: { resource: "https://mcp.example.com" },
		});
		expect(updated.data).toEqual(updatedConfig);
		expect(
			requests.map((r) => `${r.method} ${new URL(r.url).pathname}`),
		).toEqual([
			"GET /api/v2/projects/p-1/branches/br-1/auth/plugins/oauth-provider",
			"PATCH /api/v2/projects/p-1/branches/br-1/auth/plugins/oauth-provider",
		]);
		expect(await requests[1]?.json()).toEqual({
			enabled: true,
			mcp: { resource: "https://mcp.example.com" },
		});
	});

	it("auth.oauthClients covers the client lifecycle and keeps the one-time secret", async () => {
		const requests: Request[] = [];
		const listedClient = { client_id: "c-list", name: "Listed" };
		const gotClient = { client_id: "c-get", name: "Fetched" };
		const createdClient = {
			client_id: "c-new",
			name: "app",
			client_secret: "s1",
		};
		const updatedClient = { client_id: "c-upd", name: "Renamed" };
		const rotatedSecret = { client_secret: "s2" };
		const responses = [
			[200, { clients: [listedClient] }],
			[200, gotClient],
			[201, createdClient],
			[200, updatedClient],
			[200, rotatedSecret],
			[204, undefined],
		] as const;
		let call = 0;
		const neon = createNeonClient({
			apiKey: "test",
			retries: 0,
			fetch: async (input, init) => {
				requests.push(new Request(input, init));
				const [status, body] = responses[call++] ?? [500, {}];
				return new Response(
					body === undefined ? null : JSON.stringify(body),
					{
						status,
						headers: { "content-type": "application/json" },
					},
				);
			},
		});
		const ids = { projectId: "p-1", branchId: "br-1" };
		expect((await neon.auth.oauthClients.list(ids)).data).toEqual([
			listedClient,
		]);
		const got = await neon.auth.oauthClients.get({
			...ids,
			clientId: "c1",
		});
		expect(got.data).toEqual(gotClient);
		const created = await neon.auth.oauthClients.create({
			...ids,
			name: "app",
			redirect_uris: ["https://app.example.com/cb"],
			type: "confidential",
			resources: [],
		});
		expect(created.data).toEqual(createdClient);
		const updated = await neon.auth.oauthClients.update({
			...ids,
			clientId: "c1",
			disabled: true,
		});
		expect(updated.data).toEqual(updatedClient);
		const rotated = await neon.auth.oauthClients.rotateSecret({
			...ids,
			clientId: "c1",
		});
		expect(rotated.data).toEqual(rotatedSecret);
		const deleted = await neon.auth.oauthClients.delete({
			...ids,
			clientId: "c1",
		});
		expect(deleted.error).toBeUndefined();
		expect(deleted.data).toBeUndefined();
		const base =
			"/api/v2/projects/p-1/branches/br-1/auth/oauth-provider/clients";
		expect(
			requests.map((r) => `${r.method} ${new URL(r.url).pathname}`),
		).toEqual([
			`GET ${base}`,
			`GET ${base}/c1`,
			`POST ${base}`,
			`PATCH ${base}/c1`,
			`POST ${base}/c1/rotate_secret`,
			`DELETE ${base}/c1`,
		]);
		expect(await requests[2]?.json()).toEqual({
			name: "app",
			redirect_uris: ["https://app.example.com/cb"],
			type: "confidential",
			resources: [],
		});
		expect(await requests[3]?.json()).toEqual({ disabled: true });
	});

	it("auth.oauthClients rejects a missing clientId before any request", async () => {
		let fetchCalls = 0;
		const neon = createNeonClient({
			apiKey: "test",
			retries: 0,
			fetch: async () => {
				fetchCalls += 1;
				return new Response("{}", { status: 200 });
			},
		});
		const { data, error } = await neon.auth.oauthClients.get({
			projectId: "p-1",
			branchId: "br-1",
		} as never);
		expect(data).toBeUndefined();
		expect(error?.name).toBe("NeonClientError");
		expect(error?.message).toBe(
			"auth.oauthClients.get requires clientId in its parameter object (string).",
		);
		expect(fetchCalls).toBe(0);
	});

	it("projects.permissions.list unwraps project_permissions", async () => {
		const neon = neonReturning(200, {
			project_permissions: [
				{ id: "perm-1", granted_to_email: "a@b.c", granted_at: "now" },
			],
		});
		const { data } = await neon.projects.permissions.list({
			projectId: "p-1",
		});
		expect(data).toHaveLength(1);
		expect(data?.[0]?.granted_to_email).toBe("a@b.c");
	});

	it("projects.recover unwraps the project", async () => {
		const neon = neonReturning(200, {
			project: { id: "p-1" },
			branches: [],
		});
		const { data } = await neon.projects.recover({ projectId: "p-1" });
		expect(data).toEqual({ id: "p-1" });
	});

	it("postgres.endpoints.listByBranch unwraps endpoints", async () => {
		const neon = neonReturning(200, { endpoints: [{ id: "ep-1" }] });
		const { data } = await neon.postgres.endpoints.listByBranch({
			projectId: "p-1",
			branchId: "br-1",
		});
		expect(data).toEqual([{ id: "ep-1" }]);
	});

	it("propagates typed errors through the ergonomic channel", async () => {
		const neon = neonReturning(403, { message: "forbidden" });
		const { data, error } = await neon.projects.permissions.list({
			projectId: "p-1",
		});
		expect(data).toBeUndefined();
		expect(error?.kind).toBe("auth");
	});
});
