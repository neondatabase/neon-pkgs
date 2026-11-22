import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createNeonClient } from "./client.js";

/**
 * A real HTTP server that closes the socket without answering, which the runtime's
 * `fetch` reports the way it reports a stale keep-alive connection the server already
 * dropped, or answers with an error status before it succeeds.
 */

let server: Server;
let baseUrl: string;
const received: string[] = [];
/** Requests to drop before answering, per `METHOD path`. */
const drops = new Map<string, number>();
/** Error statuses to answer, in order, before succeeding, per `METHOD path`. */
const failures = new Map<string, number[]>();

const operation = (status: string) => ({
	id: "op-1",
	project_id: "p-1",
	action: "start_compute",
	status,
});

const body = (key: string) => {
	if (key.startsWith("GET /projects/p-1/connection_uri")) {
		return { uri: "postgresql://owner:pw@host/neondb" };
	}
	if (key === "GET /projects/p-1/operations/op-1") {
		return { operation: operation("finished") };
	}
	return {
		project: { id: "p-1", name: "test" },
		operations: [operation("running")],
	};
};

beforeAll(async () => {
	server = createServer((req, res) => {
		const key = `${req.method} ${req.url}`;
		received.push(key);
		const remaining = drops.get(key) ?? 0;
		if (remaining > 0) {
			drops.set(key, remaining - 1);
			req.socket.destroy();
			return;
		}
		const status = failures.get(key)?.shift() ?? 200;
		res.writeHead(status, { "content-type": "application/json" });
		res.end(
			JSON.stringify(
				status === 200
					? body(key)
					: { message: "platform service error" },
			),
		);
	});
	await new Promise<void>((resolve) =>
		server.listen(0, "127.0.0.1", resolve),
	);
	const { port } = server.address() as AddressInfo;
	baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
	server.closeAllConnections?.();
	await new Promise<void>((resolve, reject) =>
		server.close((error) => (error ? reject(error) : resolve())),
	);
});

beforeEach(() => {
	received.length = 0;
	drops.clear();
	failures.clear();
});

describe("a connection dropped before any response", () => {
	it("sends a GET again", async () => {
		drops.set("GET /projects/p-1", 1);
		const neon = createNeonClient({ apiKey: "k", baseUrl });

		const { data, error } = await neon.projects.get({ projectId: "p-1" });

		expect(error).toBeUndefined();
		expect(data?.id).toBe("p-1");
		expect(received).toEqual(["GET /projects/p-1", "GET /projects/p-1"]);
	});

	it("sends a connection-string lookup again", async () => {
		const lookup =
			"GET /projects/p-1/connection_uri?branch_id=br-1&database_name=neondb&role_name=owner&pooled=true";
		drops.set(lookup, 1);
		const neon = createNeonClient({ apiKey: "k", baseUrl });

		const { data, error } = await neon.postgres.connectionString({
			projectId: "p-1",
			branchId: "br-1",
			databaseName: "neondb",
			roleName: "owner",
		});

		expect(error).toBeUndefined();
		expect(data).toBe("postgresql://owner:pw@host/neondb");
		expect(received).toEqual([lookup, lookup]);
	});

	it("gives up on a GET after `retries`", async () => {
		drops.set("GET /projects/p-1", Number.POSITIVE_INFINITY);
		const neon = createNeonClient({ apiKey: "k", baseUrl, retries: 2 });

		const { error } = await neon.projects.get({ projectId: "p-1" });

		if (error?.kind !== "network")
			throw new Error("expected network error");
		expect(["ECONNRESET", "EPIPE", "UND_ERR_SOCKET"]).toContain(
			error.reason,
		);
		expect(received).toHaveLength(3);
	});

	it("never sends a mutation again, since the API may have applied it", async () => {
		drops.set("POST /projects", 1);
		drops.set("DELETE /projects/p-1", 1);
		const neon = createNeonClient({ apiKey: "k", baseUrl });

		const created = await neon.projects.create(
			{ name: "test" },
			{ waitForReadiness: false },
		);
		const deleted = await neon.projects.delete({ projectId: "p-1" });

		expect(created.error?.kind).toBe("network");
		expect(deleted.error?.kind).toBe("network");
		expect(received).toEqual(["POST /projects", "DELETE /projects/p-1"]);
	});
});

describe("a 500 or 502 answer", () => {
	it.each([500, 502])("sends a GET again after a %i", async (status) => {
		failures.set("GET /projects/p-1", [status]);
		const neon = createNeonClient({ apiKey: "k", baseUrl });

		const { data, error } = await neon.projects.get({ projectId: "p-1" });

		expect(error).toBeUndefined();
		expect(data?.id).toBe("p-1");
		expect(received).toEqual(["GET /projects/p-1", "GET /projects/p-1"]);
	});

	it("sends a connection-string lookup again", async () => {
		const lookup =
			"GET /projects/p-1/connection_uri?branch_id=br-1&database_name=neondb&role_name=owner&pooled=true";
		failures.set(lookup, [502]);
		const neon = createNeonClient({ apiKey: "k", baseUrl });

		const { data, error } = await neon.postgres.connectionString({
			projectId: "p-1",
			branchId: "br-1",
			databaseName: "neondb",
			roleName: "owner",
		});

		expect(error).toBeUndefined();
		expect(data).toBe("postgresql://owner:pw@host/neondb");
		expect(received).toEqual([lookup, lookup]);
	});

	it("polls an accepted mutation's operation again", async () => {
		failures.set("GET /projects/p-1/operations/op-1", [500]);
		const neon = createNeonClient({ apiKey: "k", baseUrl });

		const { error } = await neon.projects.create(
			{ name: "test" },
			{ waitForReadiness: true, wait: { pollIntervalMs: 1 } },
		);

		expect(error).toBeUndefined();
		expect(received).toEqual([
			"POST /projects",
			"GET /projects/p-1/operations/op-1",
			"GET /projects/p-1/operations/op-1",
		]);
	});

	it("gives up on a GET after `retries` with the last status", async () => {
		failures.set("GET /projects/p-1", [500, 502, 500]);
		const neon = createNeonClient({ apiKey: "k", baseUrl, retries: 2 });

		const { error } = await neon.projects.get({ projectId: "p-1" });

		expect(error).toMatchObject({ kind: "api", status: 500 });
		expect(received).toHaveLength(3);
	});

	it("does not send a GET again after a gateway timeout", async () => {
		failures.set("GET /projects/p-1", [504]);
		const neon = createNeonClient({ apiKey: "k", baseUrl });

		const { error } = await neon.projects.get({ projectId: "p-1" });

		expect(error).toMatchObject({ kind: "api", status: 504 });
		expect(received).toEqual(["GET /projects/p-1"]);
	});

	it.each([
		500, 502,
	])("never sends a mutation again after a %i, since the API may have applied it", async (status) => {
		failures.set("POST /projects", [status]);
		failures.set("DELETE /projects/p-1", [status]);
		const neon = createNeonClient({ apiKey: "k", baseUrl });

		const created = await neon.projects.create(
			{ name: "test" },
			{ waitForReadiness: false },
		);
		const deleted = await neon.projects.delete({ projectId: "p-1" });

		expect(created.error).toMatchObject({ kind: "api", status });
		expect(deleted.error).toMatchObject({ kind: "api", status });
		expect(received).toEqual(["POST /projects", "DELETE /projects/p-1"]);
	});
});
