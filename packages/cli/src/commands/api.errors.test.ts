import { fork } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Error responses that the emocks fixtures can't produce: empty bodies, response
// headers, and a body large enough to outlast a slow stdout reader.

const BIG_ITEMS = Array.from({ length: 40_000 }, (_, i) => `item-${i}`);

let server: Server;
let apiHost: string;

beforeAll(async () => {
	server = createServer((req, res) => {
		const path = new URL(req.url ?? "/", "http://localhost").pathname;
		if (path === "/nope/route") {
			res.writeHead(404);
			res.end();
		} else if (path === "/projects/broken") {
			res.writeHead(500);
			res.end();
		} else if (path === "/conflict") {
			res.writeHead(409, {
				"content-type": "application/json",
				"x-request-id": "req-1",
			});
			res.end(
				JSON.stringify({
					code: "CONFLICT",
					message: "Project is locked",
				}),
			);
		} else if (path === "/big") {
			res.writeHead(422, { "content-type": "application/json" });
			res.end(JSON.stringify({ message: "too big", items: BIG_ITEMS }));
		} else {
			res.writeHead(401, { "content-type": "application/json" });
			res.end(JSON.stringify({ message: "unauthorized" }));
		}
	});
	await new Promise<void>((resolve) =>
		server.listen(0, "127.0.0.1", resolve),
	);
	apiHost = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
	await new Promise<void>((resolve) => server.close(() => resolve()));
});

const run = (args: string[], { slowReader = false } = {}) =>
	new Promise<{ code: number | null; stdout: string; stderr: string }>(
		(resolve) => {
			const cp = fork(
				join(process.cwd(), "dist/index.js"),
				[
					...args,
					"--api-host",
					apiHost,
					"--api-key",
					"test-key",
					"--config-dir",
					mkdtempSync(join(tmpdir(), "neon-api-errors-")),
					"--no-analytics",
				],
				{ stdio: "pipe", env: { PATH: process.env.PATH } },
			);
			let stdout = "";
			let stderr = "";
			cp.stdout?.on("data", (chunk) => {
				stdout += chunk;
			});
			cp.stderr?.on("data", (chunk) => {
				stderr += chunk;
			});
			if (slowReader) {
				cp.stdout?.pause();
				setTimeout(() => cp.stdout?.resume(), 500);
			}
			cp.on("close", (code) => resolve({ code, stdout, stderr }));
		},
	);

describe("api error output", () => {
	it("names the status and path when the response has no message", async () => {
		const result = await run(["api", "/nope/route"]);
		expect(result).toEqual({
			code: 1,
			stdout: "",
			stderr: "ERROR: HTTP 404 Not Found | /nope/route\n",
		});
	});

	it("uses the same line for other commands", async () => {
		const result = await run(["projects", "get", "broken"]);
		expect(result.code).toBe(1);
		expect(result.stderr).toBe(
			"ERROR: HTTP 500 Internal Server Error | /projects/broken\n",
		);
	});

	it("prints the failed response on stdout with -i", async () => {
		const result = await run(["api", "/conflict", "-i"]);
		expect(result.code).toBe(1);
		expect(result.stdout).toMatch(/^HTTP 409 Conflict\n/);
		expect(result.stdout).toContain("x-request-id: req-1\n");
		expect(result.stdout).toMatch(
			/\n\n\{\n {2}"code": "CONFLICT",\n {2}"message": "Project is locked"\n\}\n$/,
		);
		expect(result.stderr).toBe("ERROR: Project is locked\n");
	});

	it("keeps failed responses off stdout without -i", async () => {
		const result = await run(["api", "/conflict"]);
		expect(result).toEqual({
			code: 1,
			stdout: "",
			stderr: "ERROR: Project is locked\n",
		});
	});

	it("does not print 401 responses, which may be retried after login", async () => {
		const result = await run(["api", "/unauthorized", "-i"]);
		expect(result.code).toBe(1);
		expect(result.stdout).toBe("");
	});

	it("writes the whole failed response before exiting", async () => {
		const result = await run(["api", "/big", "-i"], { slowReader: true });
		expect(result.code).toBe(1);
		const body = result.stdout.slice(result.stdout.indexOf("\n\n") + 2);
		expect(JSON.parse(body)).toEqual({
			message: "too big",
			items: BIG_ITEMS,
		});
	});
});
