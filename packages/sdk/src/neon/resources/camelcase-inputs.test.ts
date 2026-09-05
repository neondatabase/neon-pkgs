import { describe, expect, it } from "vitest";
import { createNeonClient } from "../client.js";

function neonRouting(
	respond: (request: { url: string; method: string; body: unknown }) => {
		status: number;
		body: unknown;
	},
) {
	const calls: Array<{ url: string; method: string; body: unknown }> = [];
	const neon = createNeonClient({
		apiKey: "test",
		retries: 0,
		fetch: async (input, init) => {
			const request = input instanceof Request ? input : undefined;
			const url = request ? request.url : String(input);
			const method = (
				request?.method ??
				init?.method ??
				"GET"
			).toUpperCase();
			const raw = request ? await request.clone().text() : init?.body;
			const call = {
				url,
				method,
				body:
					typeof raw === "string" && raw.length > 0
						? JSON.parse(raw)
						: raw,
			};
			calls.push(call);
			const { status, body } = respond(call);
			return new Response(JSON.stringify(body), {
				status,
				headers: { "content-type": "application/json" },
			});
		},
	});
	return { neon, calls };
}

describe("camelCase create/update inputs", () => {
	it("maps endpoints.create to snake_case and groups compute", async () => {
		const { neon, calls } = neonRouting(() => ({
			status: 201,
			body: { endpoint: { id: "ep-1", branch_id: "br-1" } },
		}));

		const { data, error } = await neon.postgres.endpoints.create("p-1", {
			branchId: "br-1",
			type: "read_write",
			regionId: "aws-us-west-2",
			compute: { minCu: 0.25, maxCu: 2, suspendTimeoutSeconds: 300 },
			poolerEnabled: true,
			passwordlessAccess: false,
		});

		expect(error).toBeUndefined();
		expect(data?.branch_id).toBe("br-1");
		expect(calls[0]?.body).toEqual({
			endpoint: {
				branch_id: "br-1",
				type: "read_write",
				region_id: "aws-us-west-2",
				autoscaling_limit_min_cu: 0.25,
				autoscaling_limit_max_cu: 2,
				suspend_timeout_seconds: 300,
				pooler_enabled: true,
				passwordless_access: false,
			},
		});
	});

	it("maps endpoints.update compute fields", async () => {
		const { neon, calls } = neonRouting(() => ({
			status: 200,
			body: { endpoint: { id: "ep-1" } },
		}));

		await neon.postgres.endpoints.update("p-1", "ep-1", {
			compute: { minCu: 1 },
		});

		expect(calls[0]?.body).toEqual({
			endpoint: { autoscaling_limit_min_cu: 1 },
		});
	});

	it("maps projects.create including orgId override and compute", async () => {
		const { neon, calls } = neonRouting(() => ({
			status: 201,
			body: { project: { id: "p-1" } },
		}));

		await neon.projects.create({
			name: "app",
			regionId: "aws-us-east-1",
			pgVersion: 17,
			orgId: "org-explicit",
			compute: { minCu: 0.25, maxCu: 1 },
			branch: { roleName: "app_owner", databaseName: "app" },
			storePasswords: true,
			historyRetentionSeconds: 86400,
		});

		expect(calls[0]?.body).toEqual({
			project: {
				name: "app",
				region_id: "aws-us-east-1",
				pg_version: 17,
				org_id: "org-explicit",
				autoscaling_limit_min_cu: 0.25,
				autoscaling_limit_max_cu: 1,
				branch: { role_name: "app_owner", database_name: "app" },
				store_passwords: true,
				history_retention_seconds: 86400,
			},
		});
	});

	it("injects the client orgId when projects.create omits orgId", async () => {
		const calls: unknown[] = [];
		const neon = createNeonClient({
			apiKey: "test",
			orgId: "org-default",
			retries: 0,
			fetch: async (input, init) => {
				const request = input instanceof Request ? input : undefined;
				const raw = request ? await request.clone().text() : init?.body;
				calls.push(
					typeof raw === "string" && raw.length > 0
						? JSON.parse(raw)
						: raw,
				);
				return new Response(
					JSON.stringify({ project: { id: "p-1" } }),
					{
						status: 201,
						headers: { "content-type": "application/json" },
					},
				);
			},
		});

		await neon.projects.create({ name: "app" });

		expect(calls[0]).toEqual({
			project: { name: "app", org_id: "org-default" },
		});
	});

	it("maps projects.update defaultEndpointSettings", async () => {
		const { neon, calls } = neonRouting(() => ({
			status: 200,
			body: { project: { id: "p-1" } },
		}));

		await neon.projects.update("p-1", {
			name: "renamed",
			historyRetentionSeconds: 3600,
			defaultEndpointSettings: { suspend_timeout_seconds: 60 },
		});

		expect(calls[0]?.body).toEqual({
			project: {
				name: "renamed",
				history_retention_seconds: 3600,
				default_endpoint_settings: { suspend_timeout_seconds: 60 },
			},
		});
	});

	it("maps databases.create ownerName", async () => {
		const { neon, calls } = neonRouting(() => ({
			status: 201,
			body: { database: { name: "app", owner_name: "app_owner" } },
		}));

		await neon.postgres.databases.create("p-1", "br-1", {
			name: "app",
			ownerName: "app_owner",
		});

		expect(calls[0]?.body).toEqual({
			database: { name: "app", owner_name: "app_owner" },
		});
	});

	it("maps roles.create noLogin", async () => {
		const { neon, calls } = neonRouting(() => ({
			status: 201,
			body: { role: { name: "reader" } },
		}));

		await neon.postgres.roles.create("p-1", "br-1", {
			name: "reader",
			noLogin: true,
		});

		expect(calls[0]?.body).toEqual({
			role: { name: "reader", no_login: true },
		});
	});

	it("maps buckets.create accessLevel", async () => {
		const { neon, calls } = neonRouting(() => ({
			status: 201,
			body: { bucket: { name: "assets" } },
		}));

		await neon.storage.buckets.create("p-1", "br-1", {
			name: "assets",
			accessLevel: "public_read",
		});

		expect(calls[0]?.body).toEqual({
			name: "assets",
			access_level: "public_read",
		});
	});

	it("injects principal_type on credentials.create", async () => {
		const { neon, calls } = neonRouting(() => ({
			status: 201,
			body: { token_id: "tok", api_token: "secret" },
		}));

		await neon.credentials.create("p-1", "br-1", {
			name: "gateway",
			scopes: ["ai_gateway:invoke"],
		});

		expect(calls[0]?.body).toEqual({
			name: "gateway",
			scopes: ["ai_gateway:invoke"],
			principal_type: "user",
		});
	});
});
