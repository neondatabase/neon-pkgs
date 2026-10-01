import { fork } from "node:child_process";
import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// connection-string starts its endpoint, role, and database lookups together but reads
// them in a fixed order. Request counts can't tell that from a sequential run, so these
// tests control when each response is sent.

const BRANCH = "br-quiet-lake-123456";
const BASE = `/projects/test/branches/${BRANCH}`;
const LOOKUPS = [`${BASE}/endpoints`, `${BASE}/roles`, `${BASE}/databases`];

const bodies: Record<string, unknown> = {
	[`${BASE}/endpoints`]: {
		endpoints: [
			{
				id: "ep-concurrent-123456",
				host: "ep-concurrent-123456.example.com",
				type: "read_write",
				branch_id: BRANCH,
			},
		],
	},
	[`${BASE}/roles`]: { roles: [{ name: "app" }] },
	[`${BASE}/databases`]: { databases: [{ name: "app", owner_name: "app" }] },
	[`${BASE}/roles/app/reveal_password`]: { password: "secret" },
};

type Handler = (
	path: string,
	send: (status: number, body?: unknown) => void,
) => void;

const json = (res: ServerResponse, status: number, body?: unknown) => {
	res.writeHead(status, { "content-type": "application/json" });
	res.end(JSON.stringify(body ?? { message: "fixture error" }));
};

const runCs = async (handler: Handler) => {
	const requests: string[] = [];
	const server = createServer((req: IncomingMessage, res: ServerResponse) => {
		const path = new URL(req.url ?? "/", "http://localhost").pathname;
		requests.push(path);
		handler(path, (status, body) => json(res, status, body));
	});
	await new Promise<void>((resolve) => server.listen(0, resolve));
	const port = (server.address() as AddressInfo).port;
	const started = Date.now();
	try {
		const result = await new Promise<{
			code: number | null;
			stdout: string;
			stderr: string;
		}>((resolve) => {
			const cp = fork(
				join(process.cwd(), "dist/index.js"),
				[
					"connection-string",
					BRANCH,
					"--project-id",
					"test",
					"--api-host",
					`http://localhost:${port}`,
					"--api-key",
					"test-key",
					"--no-analytics",
				],
				{
					stdio: "pipe",
					execArgv: ["--unhandled-rejections=strict"],
					env: { PATH: process.env.PATH },
				},
			);
			let stdout = "";
			let stderr = "";
			cp.stdout?.on("data", (d) => {
				stdout += d;
			});
			cp.stderr?.on("data", (d) => {
				stderr += d;
			});
			cp.on("close", (code) => resolve({ code, stdout, stderr }));
		});
		return { ...result, requests, ms: Date.now() - started };
	} finally {
		server.closeAllConnections();
		await new Promise((resolve) => server.close(resolve));
	}
};

describe("connection-string lookups", () => {
	it("requests endpoints, roles, and databases before any of them answers", async () => {
		const held: Array<() => void> = [];
		const arrived = new Set<string>();
		const result = await runCs((path, send) => {
			if (!LOOKUPS.includes(path)) {
				send(200, bodies[path]);
				return;
			}
			arrived.add(path);
			held.push(() => send(200, bodies[path]));
			if (arrived.size === LOOKUPS.length) {
				for (const release of held.splice(0)) {
					release();
				}
			} else {
				// A sequential client never sends the next lookup; fail it instead of hanging.
				setTimeout(() => send(500), 2000);
			}
		});
		expect(result.stderr).toBe("");
		expect(result.code).toBe(0);
		expect(result.stdout).toMatch(/^postgresql:\/\/app:secret@/);
	});

	it("reports the endpoint error even when a later lookup fails first", async () => {
		const result = await runCs((path, send) => {
			if (path === `${BASE}/endpoints`) {
				setTimeout(() => send(200, { endpoints: [] }), 200);
			} else if (
				path === `${BASE}/roles` ||
				path === `${BASE}/databases`
			) {
				send(500);
			} else {
				send(200, bodies[path]);
			}
		});
		expect(result.code).toBe(1);
		expect(result.stderr).toContain(
			`No  endpoint found for the branch: ${BRANCH}`,
		);
		expect(result.requests).not.toContain(
			`${BASE}/roles/app/reveal_password`,
		);
	});

	it("fails on the endpoint error without waiting for a stalled database lookup", async () => {
		const result = await runCs((path, send) => {
			if (path === `${BASE}/databases`) {
				return;
			}
			if (path === `${BASE}/endpoints`) {
				send(200, { endpoints: [] });
				return;
			}
			send(200, bodies[path]);
		});
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("No  endpoint found");
		expect(result.ms).toBeLessThan(10_000);
		expect(result.requests).not.toContain(
			`${BASE}/roles/app/reveal_password`,
		);
	});
});
