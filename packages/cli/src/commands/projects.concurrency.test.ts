import { fork } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node-pty";
import { beforeAll, describe, expect, it } from "vitest";

// `projects list` starts the owned and shared listings together but reads the owned one
// first. Request counts can't tell that from a sequential run, so these tests control
// when each response is sent.

beforeAll(() => {
	const spawnHelper = join(
		process.cwd(),
		"node_modules",
		"node-pty",
		"prebuilds",
		`${process.platform}-${process.arch}`,
		"spawn-helper",
	);
	if (existsSync(spawnHelper)) chmodSync(spawnHelper, 0o755);
});

const OWNED = "/projects";
const SHARED = "/projects/shared";

type Arrival = {
	path: string;
	query: URLSearchParams;
	send: (status: number, body?: unknown) => void;
	closed: Promise<void>;
};

const page = (prefix: string, count: number, cursor?: string) => ({
	projects: Array.from({ length: count }, (_, i) => ({
		id: `${prefix}-${i}`,
		name: `${prefix}-${i}`,
		region_id: "aws-us-east-2",
		created_at: "2026-01-01T00:00:00Z",
	})),
	...(cursor ? { pagination: { cursor } } : {}),
});

const startServer = async (handler: (arrival: Arrival) => void) => {
	const arrivals: Arrival[] = [];
	const server = createServer((req: IncomingMessage, res: ServerResponse) => {
		const url = new URL(req.url ?? "/", "http://localhost");
		const arrival: Arrival = {
			path: url.pathname,
			query: url.searchParams,
			send: (status, body) => {
				res.writeHead(status, { "content-type": "application/json" });
				res.end(JSON.stringify(body ?? { message: "fixture error" }));
			},
			closed: new Promise((resolve) => res.on("close", () => resolve())),
		};
		arrivals.push(arrival);
		handler(arrival);
	});
	await new Promise<void>((resolve) =>
		server.listen(0, "127.0.0.1", resolve),
	);
	return {
		arrivals,
		apiHost: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
		close: async () => {
			server.closeAllConnections();
			await new Promise((resolve) => server.close(resolve));
		},
	};
};

const cliArgs = (apiHost: string, root: string) => [
	"projects",
	"list",
	"--api-host",
	apiHost,
	"--api-key",
	"test-key",
	"--config-dir",
	join(root, "config"),
	"--context-file",
	join(root, ".neon"),
	"--no-analytics",
];

const runList = async (handler: (arrival: Arrival) => void) => {
	const server = await startServer(handler);
	const root = mkdtempSync(join(tmpdir(), "neon-projects-list-"));
	const started = Date.now();
	try {
		const result = await new Promise<{
			code: number | null;
			stdout: string;
			stderr: string;
		}>((resolve) => {
			const cp = fork(
				join(process.cwd(), "dist/index.js"),
				[...cliArgs(server.apiHost, root), "--output", "json"],
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
		return {
			...result,
			arrivals: server.arrivals,
			ms: Date.now() - started,
		};
	} finally {
		await server.close();
		rmSync(root, { recursive: true, force: true });
	}
};

describe("projects list", () => {
	it("starts both listings together and paginates each on its own cursor", async () => {
		const held: Arrival[] = [];
		let fallback: NodeJS.Timeout | undefined;
		const result = await runList((arrival) => {
			const cursor = arrival.query.get("cursor");
			if (cursor === "owned-2") {
				arrival.send(200, page("owned-b", 1));
			} else if (cursor === "shared-2") {
				arrival.send(200, page("shared-b", 1));
			} else {
				held.push(arrival);
				if (held.length === 2) {
					clearTimeout(fallback);
					const shared = held.find((a) => a.path === SHARED);
					const owned = held.find((a) => a.path === OWNED);
					shared?.send(200, page("shared-a", 100, "shared-2"));
					setTimeout(
						() => owned?.send(200, page("owned-a", 100, "owned-2")),
						50,
					);
				} else {
					// A sequential client never sends the second listing; fail instead of hanging.
					fallback = setTimeout(() => arrival.send(500), 2000);
				}
			}
		});
		expect(result.stderr).toBe("");
		expect(result.code).toBe(0);
		expect(
			result.arrivals.map(
				(a) => `${a.path}?${a.query.get("cursor") ?? ""}`,
			),
		).toEqual(
			expect.arrayContaining([
				`${OWNED}?`,
				`${SHARED}?`,
				`${OWNED}?owned-2`,
				`${SHARED}?shared-2`,
			]),
		);
		expect(result.arrivals).toHaveLength(4);
		const output = JSON.parse(result.stdout);
		expect(Object.keys(output)).toEqual(["projects", "shared_with_you"]);
		expect(output.projects.map((p: { id: string }) => p.id)).toEqual([
			...page("owned-a", 100).projects.map((p) => p.id),
			"owned-b-0",
		]);
		expect(output.shared_with_you.map((p: { id: string }) => p.id)).toEqual(
			[...page("shared-a", 100).projects.map((p) => p.id), "shared-b-0"],
		);
	});

	it("reports the owned error even when the shared listing fails first", async () => {
		const result = await runList((arrival) => {
			if (arrival.path === SHARED) {
				arrival.send(500, { message: "shared listing failed" });
			} else {
				setTimeout(
					() =>
						arrival.send(500, { message: "owned listing failed" }),
					200,
				);
			}
		});
		expect(result.code).toBe(1);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("ERROR: owned listing failed");
		expect(result.stderr).not.toContain("shared listing failed");
	});

	it("reports a shared error once the owned listing succeeds", async () => {
		const result = await runList((arrival) => {
			if (arrival.path === SHARED) {
				arrival.send(500, { message: "shared listing failed" });
			} else {
				setTimeout(() => arrival.send(200, page("owned", 1)), 200);
			}
		});
		expect(result.code).toBe(1);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("ERROR: shared listing failed");
	});

	it("fails without waiting for a stalled shared listing", async () => {
		const result = await runList((arrival) => {
			if (arrival.path === OWNED) {
				arrival.send(500, { message: "owned listing failed" });
			}
		});
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("ERROR: owned listing failed");
		expect(result.ms).toBeLessThan(10_000);
	});

	it("recovers from a missing org id and exits while the shared listing is stalled", async () => {
		let sharedClosed: Promise<void> | undefined;
		// The owned 400 waits for the shared request, so the abort always hits one in flight.
		let rejectOwned: (() => void) | undefined;
		const server = await startServer((arrival) => {
			if (arrival.path === SHARED) {
				sharedClosed = arrival.closed;
				rejectOwned?.();
			} else if (arrival.path === "/users/me/organizations") {
				arrival.send(200, {
					organizations: [{ id: "org-picked", name: "Picked" }],
				});
			} else if (arrival.query.get("org_id") === "org-picked") {
				arrival.send(200, page("org-project", 1));
			} else {
				rejectOwned = () =>
					arrival.send(400, { message: "org_id is required" });
				if (sharedClosed) {
					rejectOwned();
				}
			}
		});
		const root = mkdtempSync(join(tmpdir(), "neon-projects-recovery-"));
		const started = Date.now();
		try {
			const result = await new Promise<{ code: number; output: string }>(
				(resolve) => {
					const term = spawn(
						process.execPath,
						[
							"--unhandled-rejections=strict",
							join(process.cwd(), "dist/index.js"),
							...cliArgs(server.apiHost, root),
						],
						{
							cols: 200,
							rows: 40,
							cwd: root,
							env: { PATH: process.env.PATH ?? "", HOME: root },
							name: "xterm-256color",
						},
					);
					let output = "";
					let answered = 0;
					term.onData((chunk) => {
						output += chunk;
						if (
							answered === 0 &&
							output.includes("What organization")
						) {
							answered = 1;
							term.write("\r");
						} else if (
							answered === 1 &&
							output.includes("use this organization by default")
						) {
							answered = 2;
							term.write("n");
						}
					});
					term.onExit(({ exitCode }) =>
						resolve({ code: exitCode, output }),
					);
				},
			);
			expect(result.code).toBe(0);
			expect(result.output).toContain("org-project-0");
			expect(Date.now() - started).toBeLessThan(10_000);
			expect(
				server.arrivals.filter((a) => a.path === SHARED),
			).toHaveLength(1);
			// The stalled shared request was aborted, not left for the server to answer.
			await sharedClosed;
		} finally {
			await server.close();
			rmSync(root, { recursive: true, force: true });
		}
	});
});
