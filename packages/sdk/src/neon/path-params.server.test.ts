import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
	createClient,
	createConfig,
	createOrgApiKey,
	deleteProjectBranchDatabase,
} from "../raw.js";
import { createNeonClient } from "./client.js";
import { NeonClientError } from "./errors.js";

/**
 * A real HTTP server records every path the runtime's `fetch` sends, so these tests see
 * the URL after dot-segment resolution, which is what the Neon API would receive.
 */

let server: Server;
let baseUrl: string;
const received: string[] = [];

beforeAll(async () => {
	server = createServer((req, res) => {
		received.push(`${req.method} ${req.url}`);
		res.writeHead(200, { "content-type": "application/json" });
		res.end("{}");
	});
	await new Promise<void>((resolve) =>
		server.listen(0, "127.0.0.1", resolve),
	);
	const { port } = server.address() as AddressInfo;
	baseUrl = `http://127.0.0.1:${port}/api/v2`;
});

afterAll(async () => {
	await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
	received.length = 0;
});

describe("dot-segment path parameters", () => {
	it("rejects them in the ergonomic client without sending a request", async () => {
		const neon = createNeonClient({ apiKey: "test", baseUrl, retries: 0 });
		for (const endpointId of ["..", "."]) {
			const res = await neon.postgres.endpoints.delete({
				projectId: "p-1",
				endpointId,
			});
			expect(res.error).toBeInstanceOf(NeonClientError);
			expect(res.error?.message).toBe(
				`Path parameter endpoint_id cannot be "${endpointId}".`,
			);
		}
		expect(received).toEqual([]);
	});

	it("throws from the ergonomic client under throwOnError", async () => {
		const neon = createNeonClient({
			apiKey: "test",
			baseUrl,
			retries: 0,
			throwOnError: true,
		});
		await expect(
			neon.postgres.endpoints.delete({
				projectId: "p-1",
				endpointId: "..",
			}),
		).rejects.toBeInstanceOf(NeonClientError);
		expect(received).toEqual([]);
	});

	it("rejects them in raw calls on a caller-built client", async () => {
		const client = createClient(
			createConfig({ auth: () => "test", baseUrl }),
		);
		const res = await createOrgApiKey({
			client,
			path: { org_id: ".." },
			body: { key_name: "k" },
		});
		expect(res.error).toBeInstanceOf(NeonClientError);
		await expect(
			createOrgApiKey({
				client,
				path: { org_id: ".." },
				body: { key_name: "k" },
				throwOnError: true,
			}),
		).rejects.toBeInstanceOf(NeonClientError);
		expect(received).toEqual([]);
	});

	it("rejects them in direct calls on a client from createClient", async () => {
		const client = createClient(
			createConfig({ auth: () => "test", baseUrl }),
		);
		const res = await client.get({
			url: "/projects/{project_id}/branches/{branch_id}/endpoints",
			path: { project_id: "p-1", branch_id: ".." },
		});
		expect(res.error).toBeInstanceOf(NeonClientError);
		expect(received).toEqual([]);
	});

	it("still runs a caller-supplied requestValidator", async () => {
		const validated: unknown[] = [];
		const client = createClient(
			createConfig({
				auth: () => "test",
				baseUrl,
				requestValidator: async (options) => {
					validated.push(options);
				},
			}),
		);
		const res = await deleteProjectBranchDatabase({
			client,
			path: { project_id: "p-1", branch_id: "br-1", database_name: "db" },
		});
		expect(res.error).toBeUndefined();
		expect(validated).toHaveLength(1);
		expect(received).toEqual([
			"DELETE /api/v2/projects/p-1/branches/br-1/databases/db",
		]);
	});

	it("sends values that only contain dots to the named route", async () => {
		const neon = createNeonClient({ apiKey: "test", baseUrl, retries: 0 });
		for (const databaseName of ["...", "a..b", ".env"]) {
			const res = await deleteProjectBranchDatabase({
				client: neon.client,
				path: {
					project_id: "p-1",
					branch_id: "br-1",
					database_name: databaseName,
				},
			});
			expect(res.error).toBeUndefined();
		}
		expect(received).toEqual([
			"DELETE /api/v2/projects/p-1/branches/br-1/databases/...",
			"DELETE /api/v2/projects/p-1/branches/br-1/databases/a..b",
			"DELETE /api/v2/projects/p-1/branches/br-1/databases/.env",
		]);
	});
});
