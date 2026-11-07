import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect } from "vitest";
import type { RecordedRequest } from "../test_utils/fixtures";
import { test } from "../test_utils/fixtures";

const COMPUTE = "ep-compute-test-123456";
const COMPUTE_PATH = `/projects/test/endpoints/${COMPUTE}`;

const recorder = () => {
	const requests: RecordedRequest[] = [];
	return {
		requests,
		onRequest: (request: RecordedRequest) => requests.push(request),
		calls: () => requests.map((r) => `${r.method} ${r.path}`),
	};
};

describe("postgres computes", () => {
	test("list without a branch lists every compute in the project", async ({
		testCliCommand,
	}) => {
		const seen = recorder();
		await testCliCommand(
			["postgres", "computes", "list", "--project-id", "test"],
			{ onRequest: seen.onRequest },
		);
		expect(seen.calls()).toEqual(["GET /projects/test/endpoints"]);
	});

	test("list --branch resolves the branch name and lists its computes", async ({
		testCliCommand,
	}) => {
		const seen = recorder();
		await testCliCommand(
			[
				"postgres",
				"computes",
				"list",
				"--project-id",
				"test",
				"--branch",
				"test_branch",
			],
			{ onRequest: seen.onRequest, output: "table" },
		);
		expect(seen.calls()).toContain(
			"GET /projects/test/branches/br-sunny-branch-123456/endpoints",
		);
	});

	test("list follows the branch .neon pins, and --all-branches lists the project", async ({
		testCliCommand,
	}) => {
		const contextFile = join(
			mkdtempSync(join(tmpdir(), "neon-computes-context-")),
			".neon",
		);
		writeFileSync(
			contextFile,
			JSON.stringify({ projectId: "test", branch: "test_branch" }),
		);
		const linked = recorder();
		await testCliCommand(
			["postgres", "computes", "list", "--context-file", contextFile],
			{ onRequest: linked.onRequest, snapshot: false },
		);
		expect(linked.calls()).toContain(
			"GET /projects/test/branches/br-sunny-branch-123456/endpoints",
		);

		const all = recorder();
		await testCliCommand(
			[
				"postgres",
				"computes",
				"list",
				"--all-branches",
				"--context-file",
				contextFile,
			],
			{ onRequest: all.onRequest, snapshot: false },
		);
		expect(all.calls()).toEqual(["GET /projects/test/endpoints"]);
	});

	test("get", async ({ testCliCommand }) => {
		await testCliCommand(
			["postgres", "computes", "get", COMPUTE, "--project-id", "test"],
			{ output: "table" },
		);
	});

	test("start waits for the operation, then reads the compute again", async ({
		testCliCommand,
	}) => {
		const seen = recorder();
		await testCliCommand(
			["postgres", "computes", "start", COMPUTE, "--project-id", "test"],
			{ onRequest: seen.onRequest, output: "table" },
		);
		expect(seen.calls()).toEqual([
			`POST ${COMPUTE_PATH}/start`,
			"GET /projects/test/operations/op-compute-start",
			`GET ${COMPUTE_PATH}`,
		]);
	});

	test("start --no-wait prints the accepted compute without polling", async ({
		testCliCommand,
	}) => {
		const seen = recorder();
		await testCliCommand(
			[
				"postgres",
				"computes",
				"start",
				COMPUTE,
				"--project-id",
				"test",
				"--no-wait",
			],
			{ onRequest: seen.onRequest, output: "table" },
		);
		expect(seen.calls()).toEqual([`POST ${COMPUTE_PATH}/start`]);
	});

	test("a failed operation exits 1 and skips the final read", async ({
		testCliCommand,
	}) => {
		const seen = recorder();
		await testCliCommand(
			[
				"postgres",
				"computes",
				"start",
				"ep-compute-failing-123456",
				"--project-id",
				"test",
			],
			{
				onRequest: seen.onRequest,
				code: 1,
				snapshot: false,
				stderr: 'ERROR: Operation op-compute-fail (start_compute) ended with status "failed": compute failed to start.',
			},
		);
		expect(seen.calls()).toEqual([
			"POST /projects/test/endpoints/ep-compute-failing-123456/start",
			"GET /projects/test/operations/op-compute-fail",
		]);
	});

	test("suspend", async ({ testCliCommand }) => {
		const seen = recorder();
		await testCliCommand(
			[
				"postgres",
				"computes",
				"suspend",
				COMPUTE,
				"--project-id",
				"test",
			],
			{ onRequest: seen.onRequest, snapshot: false },
		);
		expect(seen.calls()).toEqual([
			`POST ${COMPUTE_PATH}/suspend`,
			`GET ${COMPUTE_PATH}`,
		]);
	});

	test("restart", async ({ testCliCommand }) => {
		const seen = recorder();
		await testCliCommand(
			[
				"postgres",
				"computes",
				"restart",
				COMPUTE,
				"--project-id",
				"test",
			],
			{ onRequest: seen.onRequest, snapshot: false },
		);
		expect(seen.calls()).toEqual([
			`POST ${COMPUTE_PATH}/restart`,
			`GET ${COMPUTE_PATH}`,
		]);
	});

	test("update sends only the flags that were passed", async ({
		testCliCommand,
	}) => {
		const seen = recorder();
		await testCliCommand(
			[
				"postgres",
				"computes",
				"update",
				COMPUTE,
				"--project-id",
				"test",
				"--cu",
				"0.5-4",
				"--suspend-timeout",
				"600",
			],
			{ onRequest: seen.onRequest, snapshot: false },
		);
		expect(seen.requests[0]).toEqual({
			method: "PATCH",
			path: COMPUTE_PATH,
			body: {
				endpoint: {
					autoscaling_limit_min_cu: 0.5,
					autoscaling_limit_max_cu: 4,
					suspend_timeout_seconds: 600,
				},
			},
		});
	});

	test("update --disabled=false re-enables connections", async ({
		testCliCommand,
	}) => {
		const seen = recorder();
		await testCliCommand(
			[
				"postgres",
				"computes",
				"update",
				COMPUTE,
				"--project-id",
				"test",
				"--disabled=false",
			],
			{ onRequest: seen.onRequest, snapshot: false },
		);
		expect(seen.requests[0]?.body).toEqual({
			endpoint: { disabled: false },
		});
	});

	test("update without a field fails before calling the API", async ({
		testCliCommand,
	}) => {
		const seen = recorder();
		await testCliCommand(
			["postgres", "computes", "update", COMPUTE, "--project-id", "test"],
			{
				onRequest: seen.onRequest,
				code: 1,
				snapshot: false,
				stderr: "ERROR: Nothing to update. Pass --cu, --suspend-timeout, --name, or --disabled.",
			},
		);
		expect(seen.calls()).toEqual([]);
	});

	test("delete", async ({ testCliCommand }) => {
		const seen = recorder();
		await testCliCommand(
			["postgres", "computes", "delete", COMPUTE, "--project-id", "test"],
			{
				onRequest: seen.onRequest,
				snapshot: false,
				stderr: `Compute ${COMPUTE} deleted`,
			},
		);
		expect(seen.calls()).toEqual([`DELETE ${COMPUTE_PATH}`]);
	});

	test("get on a compute that does not exist exits 1", async ({
		testCliCommand,
	}) => {
		await testCliCommand(
			[
				"postgres",
				"computes",
				"get",
				"ep-missing",
				"--project-id",
				"test",
			],
			{ code: 1, snapshot: false, stderr: "ERROR: Not Found" },
		);
	});
});

describe("postgres group aliases", () => {
	test("pg and lakebase reach the same commands as postgres", async ({
		testCliCommand,
	}) => {
		for (const group of ["pg", "lakebase"]) {
			const seen = recorder();
			await testCliCommand(
				[group, "endpoints", "get", COMPUTE, "--project-id", "test"],
				{ onRequest: seen.onRequest, snapshot: false },
			);
			expect(seen.calls()).toEqual([`GET ${COMPUTE_PATH}`]);
		}
	});

	test("postgres roles list matches roles list", async ({
		testCliCommand,
	}) => {
		const args = [
			"list",
			"--project-id",
			"test",
			"--branch",
			"test_branch",
		];
		const nested = await testCliCommand(["postgres", "roles", ...args], {
			snapshot: false,
		});
		const topLevel = await testCliCommand(["roles", ...args], {
			snapshot: false,
		});
		expect(nested.stdout).toEqual(topLevel.stdout);
	});

	test("postgres databases list matches databases list", async ({
		testCliCommand,
	}) => {
		const args = [
			"list",
			"--project-id",
			"test",
			"--branch",
			"test_branch",
		];
		const nested = await testCliCommand(
			["postgres", "databases", ...args],
			{
				snapshot: false,
			},
		);
		const topLevel = await testCliCommand(["databases", ...args], {
			snapshot: false,
		});
		expect(nested.stdout).toEqual(topLevel.stdout);
	});

	test("postgres cs matches connection-string", async ({
		testCliCommand,
	}) => {
		const args = [
			"br-sunny-branch-123456",
			"--project-id",
			"test",
			"--database-name",
			"test_db",
		];
		const options = { mockDir: "data-api-roles", snapshot: false };
		const nested = await testCliCommand(
			["postgres", "cs", ...args],
			options,
		);
		const topLevel = await testCliCommand(
			["connection-string", ...args],
			options,
		);
		expect(nested.stdout).toContain("postgresql://neondb_owner:test_pwd@");
		expect(nested.stdout).toEqual(topLevel.stdout);
	});
});
