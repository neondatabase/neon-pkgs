import { fork } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import emocks from "emocks";
import express from "express";
import { afterEach, describe, expect, test } from "vitest";
import { NeonApiError } from "../api.js";
import { clearAuthContext, setAuthContext } from "../auth_context.js";
import { type LinkProps, runLink } from "./link.js";

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

const tempDir = (): string => {
	const dir = mkdtempSync(join(tmpdir(), "neonctl-link-requests-"));
	dirs.push(dir);
	return dir;
};

const deferred = <T>() => {
	let resolve: (value: T) => void = () => undefined;
	let reject: (reason: unknown) => void = () => undefined;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
};

const flush = () => new Promise((resolve) => setImmediate(resolve));

const PROJECT = { data: { project: { id: "proj-1", org_id: "org-1" } } };
const BRANCHES = {
	data: { branches: [{ id: "br-dev-123456", name: "dev", default: true }] },
};

/** An API client whose project and branch reads wait for the test, recording when each starts. */
const gatedClient = () => {
	const started: string[] = [];
	const project = deferred<typeof PROJECT>();
	const branches = deferred<typeof BRANCHES>();
	const apiClient = {
		getProject: () => {
			started.push("project");
			return project.promise;
		},
		listProjectBranches: () => {
			started.push("branches");
			return branches.promise;
		},
	};
	return { apiClient, started, project, branches };
};

const linkProps = (apiClient: unknown, contextFile: string): LinkProps => ({
	apiClient: apiClient as never,
	apiKey: "test-key",
	apiHost: "https://console.neon.tech/api/v2",
	output: "yaml",
	contextFile,
	projectId: "proj-1",
	branch: "dev",
	yes: false,
	clear: false,
	checks: true,
	envPull: false,
});

describe("link request scheduling", () => {
	test("lists branches while the project check is in flight, then pins the branch", async () => {
		const { apiClient, started, project, branches } = gatedClient();
		const contextFile = join(tempDir(), ".neon");
		const linked = runLink(linkProps(apiClient, contextFile));
		await flush();
		expect(new Set(started)).toEqual(new Set(["project", "branches"]));

		branches.resolve(BRANCHES);
		project.resolve(PROJECT);
		await linked;
		expect(JSON.parse(readFileSync(contextFile, "utf8"))).toMatchObject({
			orgId: "org-1",
			projectId: "proj-1",
			branch: "dev",
		});
	});

	test("reports the project error when the branch listing fails first", async () => {
		const { apiClient, project, branches } = gatedClient();
		const contextFile = join(tempDir(), ".neon");
		const linked = runLink(linkProps(apiClient, contextFile));
		linked.catch(() => undefined);
		await flush();
		branches.reject(new NeonApiError("branches failed", { status: 500 }));
		await flush();
		project.reject(new NeonApiError("not found", { status: 404 }));
		await expect(linked).rejects.toThrow("Project 'proj-1' not found");
	});

	test("on Claimable Neon, lists branches only after the project check", async () => {
		setAuthContext({ source: "claimable", configDir: "" });
		const { apiClient, started, project, branches } = gatedClient();
		const contextFile = join(tempDir(), ".neon");
		const linked = runLink(linkProps(apiClient, contextFile));
		await flush();
		expect(started).toEqual(["project"]);

		project.resolve(PROJECT);
		await flush();
		expect(started).toEqual(["project", "branches"]);
		branches.resolve(BRANCHES);
		await linked;
	});
});

describe("link with the bundled env pull", () => {
	test("writes the env file without listing branches again after link and pullConfig", async () => {
		const seen: string[] = [];
		const app = express();
		app.use((req, _res, next) => {
			seen.push(`${req.method} ${req.path}`);
			next();
		});
		// The shared fixtures lack the compute settings and Preview listings the env pull
		// reads; serve what the API returns for a branch with none of those features.
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
			"/projects/test/branches/br-sunny-branch-123456/realtime",
			(_req, res) => {
				res.send({ enabled: false, pending: false });
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
			res.send({
				uri: `postgresql://neondb_owner:pw@${host}.test/neondb`,
			});
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
		const dir = tempDir();

		const result = await new Promise<{
			code: number | null;
			stderr: string;
		}>((resolve, reject) => {
			const cp = fork(
				join(process.cwd(), "./dist/index.js"),
				[
					"--api-host",
					`http://localhost:${(server.address() as AddressInfo).port}`,
					"--api-key",
					"test-key",
					"--no-analytics",
					"link",
					"--project-id",
					"test",
					"--branch",
					"test_branch",
					"--context-file",
					join(dir, ".neon"),
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
			cp.on("close", (code) => resolve({ code, stderr }));
		});

		expect(result.code).toBe(0);
		expect(result.stderr).not.toContain("pulling its Neon env vars failed");
		expect(readFileSync(join(dir, ".env.local"), "utf8")).toMatch(
			/^DATABASE_URL=/m,
		);
		// Link's listing and pullConfig's. The env pull reuses link's branch, and env resolution
		// reuses pullConfig's, so neither lists again.
		expect(
			seen.filter((r) => r === "GET /projects/test/branches"),
		).toHaveLength(2);
	});
});
