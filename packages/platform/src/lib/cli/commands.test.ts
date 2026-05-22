import { afterEach, describe, expect, test } from "vitest";
import { ErrorCode, PlatformError } from "../errors.js";
import { FakeNeonApi } from "../fake-neon-api.js";
import type { NeonApi } from "../neon-api.js";
import { makeTempRepo } from "../test-utils.js";
import { runContext, runPull, runPush } from "./commands.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
	while (cleanups.length > 0) cleanups.shift()?.();
});

function setup(files: Record<string, string | null>) {
	const repo = makeTempRepo(files);
	cleanups.push(repo.cleanup);
	return repo.root;
}

const PLATFORM_SRC = new URL("../../v1.ts", import.meta.url).pathname;

function seededFake(): { api: FakeNeonApi; projectId: string } {
	const api = new FakeNeonApi();
	const projectId = "proj-cli";
	api.seedProject({
		project: {
			id: projectId,
			name: "cli-test",
			regionId: "aws-us-east-1",
			pgVersion: 17,
			orgId: "org-cli",
		},
	});
	return { api, projectId };
}

describe("runPull", () => {
	test("default format `ts` emits a neon.ts snippet", async () => {
		const { api, projectId } = seededFake();
		const result = await runPull(
			{ projectId },
			{ cwd: process.cwd(), env: {}, api },
		);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain(
			'import { defineConfig } from "@neondatabase/platform/v1"',
		);
		expect(result.stdout).toContain('"name": "cli-test"');
		expect(result.stderr).toBe("");
	});

	test("--format json emits raw JSON", async () => {
		const { api, projectId } = seededFake();
		const result = await runPull(
			{ projectId, format: "json" },
			{ cwd: process.cwd(), env: {}, api },
		);
		expect(result.exitCode).toBe(0);
		const parsed = JSON.parse(result.stdout);
		expect(parsed.project.name).toBe("cli-test");
	});

	test("missing api key without injected api → exit 1 with helpful message", async () => {
		// Point HOME at an empty temp dir so the neonctl credentials fallback also misses.
		const emptyHome = setup({ ".config/neonctl/.keep": "" });
		const result = await runPull(
			{ projectId: "proj-x" },
			{
				cwd: process.cwd(),
				env: { HOME: emptyHome, USERPROFILE: emptyHome },
			},
		);
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("NEON_API_KEY");
		expect(result.stderr).toContain("neonctl auth");
	});

	test("missing context (no projectId, no .neon, no env) → exit 3", async () => {
		const { api } = seededFake();
		const root = setup({ "package.json": "{}" });
		const result = await runPull({}, { cwd: root, env: {}, api });
		expect(result.exitCode).toBe(3);
		expect(result.stderr).toContain("Missing context");
	});
});

describe("runPush", () => {
	test("happy path: pushes neon.ts loaded from cwd, prints summary", async () => {
		const { api, projectId } = seededFake();
		const root = setup({
			"package.json": "{}",
			".neon/project.json": JSON.stringify({ projectId }),
			"neon.ts": `
import { defineConfig } from "${PLATFORM_SRC}";
export default defineConfig({
  project: { name: "cli-test", region: "aws-us-east-1" },
  branchBlueprints: {
    production: {},
    staging: { parent: "production" },
  },
});
`,
		});
		const result = await runPush({}, { cwd: root, env: {}, api });
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain(
			`pushed config to project ${projectId}`,
		);
		expect(result.stdout).toContain("staging");
		// Real changes are listed; project-level noop entries are filtered out.
		expect(result.stdout).not.toContain("noop");
	});

	test("fully in-sync push prints a clear 'is already in sync' summary", async () => {
		const api = new FakeNeonApi();
		const projectId = "proj-sync";
		api.seedProject({
			project: {
				id: projectId,
				name: "cli-test",
				regionId: "aws-us-east-1",
				pgVersion: 17,
				orgId: "org-sync",
			},
		});
		const root = setup({
			"package.json": "{}",
			".neon/project.json": JSON.stringify({ projectId }),
			"neon.ts": `
import { defineConfig } from "${PLATFORM_SRC}";
export default defineConfig({
  project: { name: "cli-test", region: "aws-us-east-1" },
  branchBlueprints: { production: {} },
});
`,
		});
		const result = await runPush({}, { cwd: root, env: {}, api });
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain(
			`project ${projectId} (org org-sync) is already in sync`,
		);
		expect(result.stdout).toContain("No changes needed");
		expect(result.stdout).not.toContain("Applied:");
		expect(result.stdout).not.toContain("noop");
		// The bare "pushed config" wording is reserved for pushes that actually
		// applied a change — using it for noop runs is misleading.
		expect(result.stdout).not.toContain("pushed config");
	});

	test("conflict without --apply-changes → exit 2", async () => {
		const { api, projectId } = seededFake();
		const root = setup({
			"package.json": "{}",
			".neon/project.json": JSON.stringify({ projectId }),
			"neon.ts": `
import { defineConfig } from "${PLATFORM_SRC}";
export default defineConfig({
  project: { name: "cli-test", region: "aws-us-east-1" },
  branchBlueprints: {
    production: { computeSettings: { autoscalingLimitMaxCu: 4 } },
  },
});
`,
		});
		const result = await runPush({}, { cwd: root, env: {}, api });
		expect(result.exitCode).toBe(2);
		expect(result.stderr).toContain("conflict");
	});

	test("--apply-changes applies branch-level drift", async () => {
		const { api, projectId } = seededFake();
		const root = setup({
			"package.json": "{}",
			".neon/project.json": JSON.stringify({ projectId }),
			"neon.ts": `
import { defineConfig } from "${PLATFORM_SRC}";
export default defineConfig({
  project: { name: "cli-test", region: "aws-us-east-1" },
  branchBlueprints: {
    production: { computeSettings: { autoscalingLimitMaxCu: 4 } },
  },
});
`,
		});
		const result = await runPush(
			{ applyChanges: true },
			{ cwd: root, env: {}, api },
		);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("update");
	});

	test("wildcard branches are summarised as skipped when --apply-existing is not set", async () => {
		const api = new FakeNeonApi();
		const projectId = "proj-cli-w";
		api.seedProject({
			project: {
				id: projectId,
				name: "cli-test",
				regionId: "aws-us-east-1",
				pgVersion: 17,
			},
			branches: [
				{
					branch: {
						id: "br-prod",
						name: "production",
						isDefault: true,
					},
				},
				{
					branch: {
						id: "br-p1",
						name: "preview-pr-1",
						isDefault: false,
						parentId: "br-prod",
					},
				},
			],
		});
		const root = setup({
			"package.json": "{}",
			".neon/project.json": JSON.stringify({ projectId }),
			"neon.ts": `
import { defineConfig } from "${PLATFORM_SRC}";
export default defineConfig({
  project: { name: "cli-test", region: "aws-us-east-1" },
  branchBlueprints: {
    production: {},
    preview: { pattern: "preview-*", computeSettings: { autoscalingLimitMaxCu: 1 } },
  },
});
`,
		});
		const result = await runPush({}, { cwd: root, env: {}, api });
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("Skipped wildcard branches");
		expect(result.stdout).toContain("preview-pr-1");
	});

	test("missing config file → exit 4 (ConfigLoadError)", async () => {
		const { api, projectId } = seededFake();
		const root = setup({
			"package.json": "{}",
			".neon/project.json": JSON.stringify({ projectId }),
		});
		const result = await runPush({}, { cwd: root, env: {}, api });
		expect(result.exitCode).toBe(4);
		expect(result.stderr).toContain("Failed to load config");
	});
});

describe("runPull / runPush — per-code exit mapping", () => {
	function apiThatThrows(err: unknown): NeonApi {
		const reject = () => Promise.reject(err);
		return {
			listProjects: reject,
			getProject: reject,
			createProject: reject,
			updateProject: reject,
			listBranches: reject,
			createBranch: reject,
			updateBranch: reject,
			listEndpoints: reject,
			updateEndpoint: reject,
		} as unknown as NeonApi;
	}

	test.each([
		[ErrorCode.Unauthorized, 6],
		[ErrorCode.Forbidden, 7],
		[ErrorCode.InsufficientScope, 7],
		[ErrorCode.NotFound, 8],
		[ErrorCode.RateLimited, 9],
		[ErrorCode.NetworkError, 10],
		[ErrorCode.ServerError, 11],
		[ErrorCode.Locked, 11],
		[ErrorCode.InternalError, 99],
	])("PlatformError(%s) maps to exit code %i", async (code, expectedExit) => {
		const api = apiThatThrows(new PlatformError(code, `simulated ${code}`));
		const result = await runPull(
			{ projectId: "proj-test" },
			{ cwd: process.cwd(), env: {}, api },
		);
		expect(result.exitCode).toBe(expectedExit);
		expect(result.stderr).toContain(`simulated ${code}`);
		expect(result.debugInfo).toContain(`code     : ${code}`);
	});

	test("non-PlatformError falls back to exit 1 and includes stack in debugInfo", async () => {
		const api = apiThatThrows(new Error("kaboom"));
		const result = await runPull(
			{ projectId: "proj-test" },
			{ cwd: process.cwd(), env: {}, api },
		);
		expect(result.exitCode).toBe(1);
		expect(result.debugInfo).toBeDefined();
		expect(result.debugInfo).toContain("kaboom");
	});

	test("push surfaces PushConflictError as exit 2 with the multi-line conflict report", async () => {
		const { api, projectId } = seededFake();
		const platformSrc = new URL("../../v1.ts", import.meta.url).pathname;
		const root = setup({
			"package.json": "{}",
			".neon/project.json": JSON.stringify({ projectId }),
			"neon.ts": `
import { defineConfig } from "${platformSrc}";
export default defineConfig({
  project: { name: "my-app", region: "aws-us-east-1" },
  branchBlueprints: { production: { computeSettings: { autoscalingLimitMaxCu: 4 } } },
});
`,
		});
		const result = await runPush({}, { cwd: root, env: {}, api });
		expect(result.exitCode).toBe(2);
		expect(result.stderr).toContain("current :");
		expect(result.stderr).toContain("fix     :");
	});
});

describe("runContext", () => {
	test("prints resolved context as JSON", () => {
		const root = setup({
			"package.json": "{}",
			".neon/project.json": JSON.stringify({
				projectId: "proj-ctx",
				orgId: "org-ctx",
				branchId: "br-ctx",
			}),
		});
		const result = runContext({}, { cwd: root, env: {} });
		expect(result.exitCode).toBe(0);
		const parsed = JSON.parse(result.stdout);
		expect(parsed.projectId).toBe("proj-ctx");
		expect(parsed.orgId).toBe("org-ctx");
		expect(parsed.branch).toEqual({ kind: "id", value: "br-ctx" });
	});

	test("call-arg --branch wins over NEON_BRANCH_ID + file branchId", () => {
		const root = setup({
			"package.json": "{}",
			".neon/project.json": JSON.stringify({
				projectId: "p",
				branchId: "br-file",
			}),
		});
		const result = runContext(
			{ branch: "feature-x" },
			{ cwd: root, env: { NEON_BRANCH_ID: "br-env" } },
		);
		expect(result.exitCode).toBe(0);
		const parsed = JSON.parse(result.stdout);
		expect(parsed.branch).toEqual({ kind: "name", value: "feature-x" });
	});

	test("no project id resolvable → exit 3", () => {
		const root = setup({ "package.json": "{}" });
		const result = runContext({}, { cwd: root, env: {} });
		expect(result.exitCode).toBe(3);
		expect(result.stderr).toContain("Missing context");
	});
});
