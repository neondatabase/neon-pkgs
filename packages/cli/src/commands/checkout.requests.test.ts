import { fork } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import emocks from "emocks";
import express, { type RequestHandler } from "express";
import { afterEach, describe, expect, test } from "vitest";
import { clearAuthContext, setAuthContext } from "../auth_context.js";
import { handler } from "./checkout.js";

const dirs: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
	clearAuthContext();
	for (const server of servers.splice(0)) {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
	for (const dir of dirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

/**
 * The `main` mocks plus what the shared fixtures lack for the bundled env pull: compute
 * settings, empty Preview listings, one database and role, and connection URIs.
 */
const startServer = async (
	seen: string[],
	before?: RequestHandler,
): Promise<string> => {
	const app = express();
	app.use((req, _res, next) => {
		seen.push(`${req.method} ${req.path}`);
		next();
	});
	if (before) app.use(before);
	app.get("/projects/test/endpoints", (_req, res) => {
		res.send({
			endpoints: [
				{
					id: "ep-sunny-123456",
					branch_id: "br-sunny-branch-123456",
					type: "read_write",
					autoscaling_limit_min_cu: 0.25,
					autoscaling_limit_max_cu: 2,
					suspend_timeout_seconds: 0,
				},
			],
		});
	});
	app.get(
		/^\/projects\/test\/branches\/br-sunny-branch-123456\/(buckets|functions|credentials)$/,
		(req, res) => {
			res.send({ [req.params[0] ?? ""]: [] });
		},
	);
	app.get(
		"/projects/test/branches/br-sunny-branch-123456/databases",
		(_req, res) => {
			res.send({
				databases: [{ name: "neondb", owner_name: "neondb_owner" }],
			});
		},
	);
	app.get(
		"/projects/test/branches/br-sunny-branch-123456/roles",
		(_req, res) => {
			res.send({ roles: [{ name: "neondb_owner" }] });
		},
	);
	app.get("/projects/test/connection_uri", (req, res) => {
		const host =
			req.query.pooled === "true" ? "ep-sunny-pooler" : "ep-sunny";
		res.send({ uri: `postgresql://neondb_owner:pw@${host}.test/neondb` });
	});
	app.use(
		"/",
		emocks(join(process.cwd(), "mocks", "main"), {
			"404": (_req, res) =>
				res.status(404).send({ message: "Not Found" }),
		}),
	);
	const server = await new Promise<Server>((resolve) => {
		const s = app.listen(0, () => resolve(s));
	});
	servers.push(server);
	return `http://localhost:${(server.address() as AddressInfo).port}`;
};

/** Checks out `test_branch` from a directory linked to project `test` with no org pinned. */
const runCheckout = (
	apiHost: string,
	extra: string[] = [],
): Promise<{ code: number | null; stderr: string; dir: string }> => {
	const dir = mkdtempSync(join(tmpdir(), "neonctl-checkout-requests-"));
	dirs.push(dir);
	const contextFile = join(dir, ".neon");
	writeFileSync(
		contextFile,
		JSON.stringify({ projectId: "test", branch: "main" }),
	);
	return new Promise((resolve, reject) => {
		const cp = fork(
			join(process.cwd(), "./dist/index.js"),
			[
				"--api-host",
				apiHost,
				"--api-key",
				"test-key",
				"--no-analytics",
				"--context-file",
				contextFile,
				"checkout",
				"test_branch",
				...extra,
			],
			{
				stdio: "pipe",
				cwd: dir,
				env: { PATH: process.env.PATH, CI: "true" },
			},
		);
		let stderr = "";
		cp.stderr?.on("data", (data: Buffer) => {
			stderr += data.toString();
		});
		cp.on("error", reject);
		cp.on("close", (code) => resolve({ code, stderr, dir }));
	});
};

describe("checkout requests", () => {
	test("reads the project while it lists branches", async () => {
		const seen: string[] = [];
		let projectReadDuringListing = false;
		// Hold the branch listing until the project read arrives; checking out sequentially
		// would never send it, so the listing is released after a bound and the test fails.
		const apiHost = await startServer(seen, async (req, _res, next) => {
			if (
				req.method === "GET" &&
				req.path === "/projects/test/branches"
			) {
				for (let i = 0; i < 100; i++) {
					if (seen.includes("GET /projects/test")) {
						projectReadDuringListing = true;
						break;
					}
					await new Promise((resolve) => setTimeout(resolve, 10));
				}
			}
			next();
		});

		const result = await runCheckout(apiHost, ["--no-env-pull"]);

		expect(result.code).toBe(0);
		expect(projectReadDuringListing).toBe(true);
	});

	test("writes the env file without listing branches again to resolve the checked-out branch", async () => {
		const seen: string[] = [];
		const apiHost = await startServer(seen);

		const result = await runCheckout(apiHost);

		expect(result.code).toBe(0);
		expect(result.stderr).not.toContain("pulling its Neon env vars failed");
		expect(readFileSync(join(result.dir, ".env.local"), "utf8")).toMatch(
			/^DATABASE_URL=/m,
		);
		// Checkout's listing and the env pull's branch read-back; the pull reuses checkout's
		// resolved branch instead of listing a third time.
		expect(
			seen.filter((r) => r === "GET /projects/test/branches"),
		).toHaveLength(2);
	});

	test("on Claimable Neon, reads the project only after the branch resolves", async () => {
		setAuthContext({ source: "claimable", configDir: "" });
		const dir = mkdtempSync(join(tmpdir(), "neonctl-checkout-claimable-"));
		dirs.push(dir);
		const started: string[] = [];
		let releaseBranches: () => void = () => undefined;
		const branchesHeld = new Promise<void>((resolve) => {
			releaseBranches = resolve;
		});
		const apiClient = {
			listProjectBranches: async () => {
				started.push("branches");
				await branchesHeld;
				return {
					data: {
						branches: [
							{ id: "br-dev-123456", name: "dev", default: true },
						],
					},
				};
			},
			getProject: async () => {
				started.push("project");
				return { data: { project: { id: "test", org_id: "org-1" } } };
			},
		};

		const checkedOut = handler({
			apiClient: apiClient as never,
			apiKey: "test-key",
			apiHost: "https://console.neon.tech/api/v2",
			output: "yaml",
			contextFile: join(dir, ".neon"),
			projectId: "test",
			id: "dev",
			envPull: false,
		});
		await new Promise((resolve) => setImmediate(resolve));
		expect(started).toEqual(["branches"]);

		releaseBranches();
		await checkedOut;
		expect(started).toEqual(["branches", "project"]);
	});
});
