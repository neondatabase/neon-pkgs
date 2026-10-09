import { fork } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import emocks from "emocks";
import express, { type RequestHandler } from "express";
import { afterEach, describe, expect, test } from "vitest";

const dirs: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
	for (const server of servers.splice(0)) {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
	for (const dir of dirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

const startServer = async (
	seen: string[],
	before?: RequestHandler,
): Promise<string> => {
	const app = express();
	app.use(express.json());
	app.use((req, _res, next) => {
		seen.push(`${req.method} ${req.path}`);
		next();
	});
	if (before) app.use(before);
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

const runSnapshots = (
	apiHost: string,
	args: string[],
): Promise<{ code: number | null; stderr: string }> => {
	const dir = mkdtempSync(join(tmpdir(), "neonctl-snapshots-requests-"));
	dirs.push(dir);
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
				join(dir, ".neon"),
				"--output",
				"yaml",
				"snapshots",
				...args,
				"--project-id",
				"test",
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
};

const SNAPSHOT = "/projects/test/snapshots/snap-first-snapshot-123456";
const MAIN = "/projects/test/branches/br-main-branch-123456";

describe("snapshots requests", () => {
	test.each([
		[
			"restore by id",
			["restore", "snap-first-snapshot-123456", "--name", "recovered"],
			[`POST ${SNAPSHOT}/restore`],
		],
		[
			"update by id",
			["update", "snap-first-snapshot-123456", "--name", "renamed"],
			[`PATCH ${SNAPSHOT}`],
		],
		[
			"create from a branch id",
			["create", "--branch", "br-main-branch-123456"],
			[`POST ${MAIN}/snapshot`],
		],
		[
			"schedule get for a branch id",
			["schedule", "get", "--branch", "br-main-branch-123456"],
			[`GET ${MAIN}/backup_schedule`],
		],
		[
			"schedule set for a branch id",
			[
				"schedule",
				"set",
				"--branch",
				"br-main-branch-123456",
				"--frequency",
				"daily",
			],
			[`PUT ${MAIN}/backup_schedule`],
		],
	])("%s sends only the request that does the work", async (_, args, expected) => {
		const seen: string[] = [];
		const apiHost = await startServer(seen);

		const result = await runSnapshots(apiHost, args);

		expect(result.code).toBe(0);
		expect(seen).toEqual(expected);
	});

	test("update falls back to the listing when a name looks like an id", async () => {
		const seen: string[] = [];
		const apiHost = await startServer(seen, (req, res, next) => {
			if (
				req.method === "GET" &&
				req.path === "/projects/test/snapshots"
			) {
				res.send({
					snapshots: [
						{
							id: "snap-first-snapshot-123456",
							name: "snap-named-like-id",
							source_branch_id: "br-main-branch-123456",
							created_at: "2021-01-01T00:00:00.000Z",
						},
					],
				});
				return;
			}
			next();
		});

		const result = await runSnapshots(apiHost, [
			"update",
			"snap-named-like-id",
			"--name",
			"renamed",
		]);

		expect(result.code).toBe(0);
		expect(seen).toEqual([
			"PATCH /projects/test/snapshots/snap-named-like-id",
			"GET /projects/test/snapshots",
			`PATCH ${SNAPSHOT}`,
		]);
	});

	test("restore of an unknown id names the available snapshots", async () => {
		const seen: string[] = [];
		const apiHost = await startServer(seen);

		const result = await runSnapshots(apiHost, [
			"restore",
			"snap-missing-snapshot-123456",
		]);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain(
			'Snapshot "snap-missing-snapshot-123456" not found.\nAvailable snapshots: nightly (snap-first-snapshot-123456), pre-migration (snap-second-snapshot-123456)',
		);
	});

	test("restore keeps the API's 404 when the snapshot id exists", async () => {
		const seen: string[] = [];
		const apiHost = await startServer(seen, (req, res, next) => {
			if (req.method === "POST" && req.path === `${SNAPSHOT}/restore`) {
				res.status(404).send({ message: "branch not found" });
				return;
			}
			next();
		});

		const result = await runSnapshots(apiHost, [
			"restore",
			"snap-first-snapshot-123456",
			"--target-branch",
			"br-missing-branch-123456",
		]);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("branch not found");
		expect(seen).toEqual([
			`POST ${SNAPSHOT}/restore`,
			"GET /projects/test/snapshots",
		]);
	});

	test("schedule set rejects invalid input before any request", async () => {
		const seen: string[] = [];
		const apiHost = await startServer(seen);

		const result = await runSnapshots(apiHost, [
			"schedule",
			"set",
			"--branch",
			"main",
			"--schedule",
			"not json",
		]);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("--schedule must be valid JSON.");
		expect(seen).toEqual([]);
	});
});
