import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createNeonClient } from "./client.js";

/**
 * A real HTTP server that closes the socket without answering, which the runtime's
 * `fetch` reports the way it reports a stale keep-alive connection the server already
 * dropped.
 */

let server: Server;
let baseUrl: string;
const received: string[] = [];
/** Requests to drop before answering, per `METHOD path`. */
const drops = new Map<string, number>();

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
		res.writeHead(200, { "content-type": "application/json" });
		res.end(
			JSON.stringify(
				req.url?.startsWith("/projects/p-1/connection_uri")
					? { uri: "postgresql://owner:pw@host/neondb" }
					: { project: { id: "p-1", name: "test" } },
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
