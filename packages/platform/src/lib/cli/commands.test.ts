import { chmodSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ErrorCode, PlatformError } from "../errors.js";
import { FakeNeonApi } from "../fake-neon-api.js";
import type { NeonApi } from "../neon-api.js";
import { makeTempRepo, stubCleanNeonEnv } from "../test-utils.js";
import {
	runBranch,
	runContext,
	runEnvPull,
	runEnvRun,
	runPull,
	runPush,
	runStatus,
} from "./commands.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
	while (cleanups.length > 0) cleanups.shift()?.();
});

beforeEach(() => {
	stubCleanNeonEnv();
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
	test("default format `ts` creates neon.ts in cwd and reports the path", async () => {
		const { api, projectId } = seededFake();
		const root = setup({ "package.json": "{}" });
		const neonPath = join(root, "neon.ts");
		expect(existsSync(neonPath)).toBe(false);

		const result = await runPull({ projectId }, { cwd: root, api });

		expect(result.exitCode).toBe(0);
		expect(result.stderr).toBe("");
		expect(result.stdout).toContain("Created");
		expect(result.stdout).toContain(neonPath);
		expect(result.stdout).not.toContain("defineConfig");

		const written = readFileSync(neonPath, "utf-8");
		expect(written).toContain(
			'import { defineConfig } from "@neondatabase/platform/v1"',
		);
		expect(written).toContain('"name": "cli-test"');
	});

	test("default format `ts` overwrites an existing neon.ts and reports 'Updated'", async () => {
		const { api, projectId } = seededFake();
		const root = setup({
			"package.json": "{}",
			"neon.ts": "// stale contents that should be replaced\n",
		});
		const neonPath = join(root, "neon.ts");

		const result = await runPull({ projectId }, { cwd: root, api });

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("Updated");
		expect(result.stdout).toContain(neonPath);

		const written = readFileSync(neonPath, "utf-8");
		expect(written).not.toContain("stale contents");
		expect(written).toContain('"name": "cli-test"');
	});

	test("default format `ts` reports a write failure without crashing", async () => {
		const { api, projectId } = seededFake();
		// Point cwd at a path that doesn't exist on disk. writeFileSync will fail
		// with ENOENT trying to create `${cwd}/neon.ts` because the directory is
		// missing — exactly the kind of unexpected filesystem error we want to
		// surface as a clean exit-1 with a useful message.
		const bogusCwd = join(setup({ ".keep": "" }), "does-not-exist-subdir");
		const result = await runPull({ projectId }, { cwd: bogusCwd, api });
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain(
			`Failed to write ${join(bogusCwd, "neon.ts")}`,
		);
	});

	test("--format json emits raw JSON to stdout and does not write neon.ts", async () => {
		const { api, projectId } = seededFake();
		const root = setup({ "package.json": "{}" });
		const result = await runPull(
			{ projectId, format: "json" },
			{ cwd: root, api },
		);
		expect(result.exitCode).toBe(0);
		const parsed = JSON.parse(result.stdout);
		expect(parsed.project.name).toBe("cli-test");
		expect(existsSync(join(root, "neon.ts"))).toBe(false);
	});

	test("missing api key without injected api → exit 1 with helpful message", async () => {
		// Point HOME at an empty temp dir so the neonctl credentials fallback also misses.
		const emptyHome = setup({ ".config/neonctl/.keep": "" });
		vi.stubEnv("HOME", emptyHome);
		vi.stubEnv("USERPROFILE", emptyHome);
		const result = await runPull(
			{ projectId: "proj-x" },
			{ cwd: process.cwd() },
		);
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("NEON_API_KEY");
		expect(result.stderr).toContain("neonctl auth");
	});

	test("missing context (no projectId, no .neon, no env) → exit 3", async () => {
		const { api } = seededFake();
		const root = setup({ "package.json": "{}" });
		const result = await runPull({}, { cwd: root, api });
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
  branches: {
    production: {},
    staging: { parent: "production" },
  },
});
`,
		});
		const result = await runPush({}, { cwd: root, api });
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
  branches: { production: {} },
});
`,
		});
		const result = await runPush({}, { cwd: root, api });
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

	test("conflict without --update-existing → exit 2", async () => {
		const { api, projectId } = seededFake();
		const root = setup({
			"package.json": "{}",
			".neon/project.json": JSON.stringify({ projectId }),
			"neon.ts": `
import { defineConfig } from "${PLATFORM_SRC}";
export default defineConfig({
  project: { name: "cli-test", region: "aws-us-east-1" },
  branches: {
    production: { computeSettings: { autoscalingLimitMaxCu: 4 } },
  },
});
`,
		});
		const result = await runPush({}, { cwd: root, api });
		expect(result.exitCode).toBe(2);
		expect(result.stderr).toContain("conflict");
	});

	test("--update-existing applies branch-level drift", async () => {
		const { api, projectId } = seededFake();
		const root = setup({
			"package.json": "{}",
			".neon/project.json": JSON.stringify({ projectId }),
			"neon.ts": `
import { defineConfig } from "${PLATFORM_SRC}";
export default defineConfig({
  project: { name: "cli-test", region: "aws-us-east-1" },
  branches: {
    production: { computeSettings: { autoscalingLimitMaxCu: 4 } },
  },
});
`,
		});
		const result = await runPush(
			{ updateExisting: true },
			{ cwd: root, api },
		);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("update");
	});

	test("wildcard-matched live branches are silently left alone (creation-only)", async () => {
		// Confirms the CLI surface stays consistent with the SDK contract: blueprints
		// never touch existing branches, so there's no "skipped wildcard branches"
		// section to print and no flag to enable one.
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
  branches: { production: {} },
  branchBlueprints: {
    preview: { pattern: "preview-*", computeSettings: { autoscalingLimitMaxCu: 1 } },
  },
});
`,
		});
		const result = await runPush({}, { cwd: root, api });
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("is already in sync");
		expect(result.stdout).not.toContain("preview-pr-1");
	});

	test("missing config file → exit 4 (ConfigLoadError)", async () => {
		const { api, projectId } = seededFake();
		const root = setup({
			"package.json": "{}",
			".neon/project.json": JSON.stringify({ projectId }),
		});
		const result = await runPush({}, { cwd: root, api });
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
			{ cwd: process.cwd(), api },
		);
		expect(result.exitCode).toBe(expectedExit);
		expect(result.stderr).toContain(`simulated ${code}`);
		expect(result.debugInfo).toContain(`code     : ${code}`);
	});

	test("non-PlatformError falls back to exit 1 and includes stack in debugInfo", async () => {
		const api = apiThatThrows(new Error("kaboom"));
		const result = await runPull(
			{ projectId: "proj-test" },
			{ cwd: process.cwd(), api },
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
  branches: { production: { computeSettings: { autoscalingLimitMaxCu: 4 } } },
});
`,
		});
		const result = await runPush({}, { cwd: root, api });
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
		const result = runContext({}, { cwd: root });
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
		vi.stubEnv("NEON_BRANCH_ID", "br-env");
		const result = runContext({ branch: "feature-x" }, { cwd: root });
		expect(result.exitCode).toBe(0);
		const parsed = JSON.parse(result.stdout);
		expect(parsed.branch).toEqual({ kind: "name", value: "feature-x" });
	});

	test("no project id resolvable → exit 3", () => {
		const root = setup({ "package.json": "{}" });
		const result = runContext({}, { cwd: root });
		expect(result.exitCode).toBe(3);
		expect(result.stderr).toContain("Missing context");
	});
});

describe("runBranch", () => {
	function previewBlueprint(): string {
		return `
import { defineConfig } from "${PLATFORM_SRC}";
export default defineConfig({
  project: { name: "cli-test", region: "aws-us-east-1" },
  branches: { production: {} },
  branchBlueprints: {
    preview: { pattern: "preview-*", ttl: "1h", parent: "production" },
  },
});
`;
	}

	function seedFakeWithProduction(): {
		api: FakeNeonApi;
		projectId: string;
		orgId: string;
	} {
		const api = new FakeNeonApi();
		const projectId = "proj-cli-branch";
		const orgId = "org-cli-branch";
		api.seedProject({
			project: {
				id: projectId,
				name: "cli-test",
				regionId: "aws-us-east-1",
				pgVersion: 17,
				orgId,
			},
			branches: [
				{
					branch: {
						id: "br-prod-cli",
						name: "production",
						isDefault: true,
					},
				},
			],
		});
		return { api, projectId, orgId };
	}

	test("creates a branch and updates an existing .neon/project.json", async () => {
		const { api, projectId, orgId } = seedFakeWithProduction();
		const root = setup({
			"package.json": "{}",
			".neon/project.json": JSON.stringify({ projectId, orgId }),
			"neon.ts": previewBlueprint(),
		});
		const result = await runBranch(
			{ blueprint: "preview" },
			{ cwd: root, api },
		);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("created branch preview-");
		expect(result.stdout).toContain("blueprint : preview");
		expect(result.stdout).toContain("parent    : production");
		expect(result.stdout).toContain(
			`updated ${join(root, ".neon", "project.json")}`,
		);

		const reread = JSON.parse(
			readFileSync(join(root, ".neon", "project.json"), "utf-8"),
		);
		expect(reread.branchId).toMatch(/^br-/);
		expect(reread.projectId).toBe(projectId);
	});

	test("when no context file exists, prints the suggested JSON payload", async () => {
		const { api, projectId, orgId } = seedFakeWithProduction();
		const root = setup({
			"package.json": "{}",
			"neon.ts": previewBlueprint(),
		});
		const result = await runBranch(
			{ blueprint: "preview", projectId, orgId },
			{ cwd: root, api },
		);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain(
			"no .neon/project.json (or .neon) found",
		);
		expect(result.stdout).toContain(`"projectId": "${projectId}"`);
		expect(result.stdout).toContain(`"orgId": "${orgId}"`);
		expect(result.stdout).toContain(`"branchId": "br-`);
	});

	test("unknown blueprint → exit 8 (NotFound)", async () => {
		const { api, projectId } = seedFakeWithProduction();
		const root = setup({
			"package.json": "{}",
			".neon/project.json": JSON.stringify({ projectId }),
			"neon.ts": previewBlueprint(),
		});
		const result = await runBranch(
			{ blueprint: "nope" },
			{ cwd: root, api },
		);
		expect(result.exitCode).toBe(8);
		expect(result.stderr).toContain('no blueprint named "nope"');
	});

	test("name refers to a concrete branch → exit 5 (InvalidConfig)", async () => {
		const { api, projectId } = seedFakeWithProduction();
		const root = setup({
			"package.json": "{}",
			".neon/project.json": JSON.stringify({ projectId }),
			"neon.ts": previewBlueprint(),
		});
		const result = await runBranch(
			{ blueprint: "production" },
			{ cwd: root, api },
		);
		expect(result.exitCode).toBe(5);
		expect(result.stderr).toContain("concrete branch");
	});

	test("missing context (no projectId/file) → exit 3", async () => {
		const { api } = seedFakeWithProduction();
		const root = setup({
			"package.json": "{}",
			"neon.ts": previewBlueprint(),
		});
		const result = await runBranch(
			{ blueprint: "preview" },
			{ cwd: root, api },
		);
		expect(result.exitCode).toBe(3);
		expect(result.stderr).toContain("Missing context");
	});

	test("missing config file → exit 4 (ConfigLoadError)", async () => {
		const { api, projectId } = seedFakeWithProduction();
		const root = setup({
			"package.json": "{}",
			".neon/project.json": JSON.stringify({ projectId }),
		});
		const result = await runBranch(
			{ blueprint: "preview" },
			{ cwd: root, api },
		);
		expect(result.exitCode).toBe(4);
		expect(result.stderr).toContain("Failed to load config");
	});

	test("read-only context file → exit 0 with a warning and the JSON payload", async () => {
		const { api, projectId, orgId } = seedFakeWithProduction();
		const root = setup({
			"package.json": "{}",
			".neon/project.json": JSON.stringify({ projectId, orgId }),
			"neon.ts": previewBlueprint(),
		});
		const filePath = join(root, ".neon", "project.json");
		chmodSync(filePath, 0o444);
		cleanups.push(() => {
			try {
				chmodSync(filePath, 0o644);
			} catch {
				/* best effort */
			}
		});

		const result = await runBranch(
			{ blueprint: "preview" },
			{ cwd: root, api },
		);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("created branch preview-");
		expect(result.stdout).toContain(`could not update ${filePath}`);
		expect(result.stdout).toContain("apply this snippet by hand");
		expect(result.stdout).toContain(`"projectId": "${projectId}"`);
	});
});

describe("runEnvPull", () => {
	function neonTsBody(): string {
		return `
import { defineConfig } from "${PLATFORM_SRC}";
export default defineConfig({
  project: { name: "cli-test", region: "aws-us-east-1" },
  branches: { production: {} },
});
`;
	}

	test("writes .env.local with DATABASE_URL + DATABASE_URL_UNPOOLED by default", async () => {
		const { api, projectId } = seededFake();
		const root = setup({
			"package.json": "{}",
			".neon/project.json": JSON.stringify({ projectId }),
			"neon.ts": neonTsBody(),
		});
		const result = await runEnvPull({}, { cwd: root, api });
		expect(result.exitCode).toBe(0);
		const targetPath = join(root, ".env.local");
		expect(result.stdout).toContain(`Created ${targetPath}`);
		const body = readFileSync(targetPath, "utf-8");
		expect(body).toMatch(/^DATABASE_URL=/m);
		expect(body).toMatch(/^DATABASE_URL_UNPOOLED=/m);
		// The connection-string URL contains `?` (query string), so the value must be
		// quoted to survive a standard .env parse.
		expect(body).toMatch(/^DATABASE_URL=["']?postgres/m);
	});

	test("honours a positional [file] argument", async () => {
		const { api, projectId } = seededFake();
		const root = setup({
			"package.json": "{}",
			".neon/project.json": JSON.stringify({ projectId }),
			"neon.ts": neonTsBody(),
		});
		const result = await runEnvPull({ file: ".env" }, { cwd: root, api });
		expect(result.exitCode).toBe(0);
		expect(existsSync(join(root, ".env"))).toBe(true);
		expect(existsSync(join(root, ".env.local"))).toBe(false);
	});

	test("reports Updated when the file already exists and preserves unrelated lines", async () => {
		const { api, projectId } = seededFake();
		const root = setup({
			"package.json": "{}",
			".neon/project.json": JSON.stringify({ projectId }),
			"neon.ts": neonTsBody(),
			".env.local":
				"# pulled from vercel\nVERCEL_FOO=bar\nDATABASE_URL=postgres://stale\n",
		});
		const result = await runEnvPull({}, { cwd: root, api });
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("Updated");
		const body = readFileSync(join(root, ".env.local"), "utf-8");
		// Unrelated content is preserved verbatim.
		expect(body).toContain("# pulled from vercel");
		expect(body).toContain("VERCEL_FOO=bar");
		// The stale DATABASE_URL is replaced in place with the live value.
		expect(body).not.toContain("postgres://stale");
		expect(body).toMatch(/^DATABASE_URL=["']?postgres/m);
		expect(body).toMatch(/^DATABASE_URL_UNPOOLED=/m);
		// No auto-generated header is injected.
		expect(body).not.toContain("Generated by");
	});

	test("does not include an auto-generated header on fresh writes", async () => {
		const { api, projectId } = seededFake();
		const root = setup({
			"package.json": "{}",
			".neon/project.json": JSON.stringify({ projectId }),
			"neon.ts": neonTsBody(),
		});
		const result = await runEnvPull({}, { cwd: root, api });
		expect(result.exitCode).toBe(0);
		const body = readFileSync(join(root, ".env.local"), "utf-8");
		expect(body).not.toContain("Generated by");
		expect(body).not.toContain("safe to commit-ignore");
	});

	test("missing config file → exit 4 (ConfigLoadError)", async () => {
		const { api, projectId } = seededFake();
		const root = setup({
			"package.json": "{}",
			".neon/project.json": JSON.stringify({ projectId }),
		});
		const result = await runEnvPull({}, { cwd: root, api });
		expect(result.exitCode).toBe(4);
		expect(result.stderr).toContain("Failed to load config");
	});
});

describe("runEnvRun", () => {
	function neonTsBody(): string {
		return `
import { defineConfig } from "${PLATFORM_SRC}";
export default defineConfig({
  project: { name: "cli-test", region: "aws-us-east-1" },
  branches: { production: {} },
});
`;
	}

	test("spawns the user command with DATABASE_URL / DATABASE_URL_UNPOOLED injected", async () => {
		const { api, projectId } = seededFake();
		const root = setup({
			"package.json": "{}",
			".neon/project.json": JSON.stringify({ projectId }),
			"neon.ts": neonTsBody(),
			// Print both injected env vars and exit. The runner captures the child's
			// stdout via stdio: "inherit" which routes through the parent — so we have
			// to assert via the exit code (a successful run) plus a side-channel.
			"check.mjs": [
				'import fs from "node:fs";',
				"fs.writeFileSync(",
				"  process.argv[2],",
				'  [process.env.DATABASE_URL, process.env.DATABASE_URL_UNPOOLED].join("\\n") + "\\n",',
				");",
			].join("\n"),
		});
		const outPath = join(root, "captured.txt");
		const result = await runEnvRun(
			{
				command: [process.execPath, join(root, "check.mjs"), outPath],
			},
			{ cwd: root, api },
		);
		expect(result.exitCode).toBe(0);
		const captured = readFileSync(outPath, "utf-8").trim().split("\n");
		expect(captured[0]).toMatch(/^postgres/);
		expect(captured[0]).toContain("-pooler");
		expect(captured[1]).toMatch(/^postgres/);
		expect(captured[1]).not.toContain("-pooler");
	});

	test("no command supplied → exit 1 with usage hint", async () => {
		const { api } = seededFake();
		const root = setup({ "package.json": "{}" });
		const result = await runEnvRun({ command: [] }, { cwd: root, api });
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("env run -- <command>");
	});

	test("propagates the child's non-zero exit code", async () => {
		const { api, projectId } = seededFake();
		const root = setup({
			"package.json": "{}",
			".neon/project.json": JSON.stringify({ projectId }),
			"neon.ts": neonTsBody(),
			"fail.mjs": "process.exit(42);",
		});
		const result = await runEnvRun(
			{ command: [process.execPath, join(root, "fail.mjs")] },
			{ cwd: root, api },
		);
		expect(result.exitCode).toBe(42);
	});

	test("missing config file → exit 4 (ConfigLoadError)", async () => {
		const { api, projectId } = seededFake();
		const root = setup({
			"package.json": "{}",
			".neon/project.json": JSON.stringify({ projectId }),
		});
		const result = await runEnvRun(
			{ command: ["echo", "hi"] },
			{ cwd: root, api },
		);
		expect(result.exitCode).toBe(4);
		expect(result.stderr).toContain("Failed to load config");
	});
});

describe("runStatus", () => {
	function neonTsBody(content: string): string {
		return `
import { defineConfig } from "${PLATFORM_SRC}";
export default defineConfig(${content});
`;
	}

	test("in-sync project prints 'in sync — push would be a no-op'", async () => {
		const { api, projectId } = seededFake();
		const root = setup({
			"package.json": "{}",
			".neon/project.json": JSON.stringify({ projectId }),
			"neon.ts": neonTsBody(
				`{ project: { name: "cli-test", region: "aws-us-east-1" }, branches: { production: {} } }`,
			),
		});
		const result = await runStatus({}, { cwd: root, api });
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain(`Status against project ${projectId}`);
		expect(result.stdout).toContain("in sync");
		expect(result.stdout).not.toContain("Plan");
	});

	test("with a missing branch: prints a + create entry under Plan", async () => {
		const { api, projectId } = seededFake();
		const root = setup({
			"package.json": "{}",
			".neon/project.json": JSON.stringify({ projectId }),
			"neon.ts": neonTsBody(
				`{ project: { name: "cli-test", region: "aws-us-east-1" }, branches: { production: {}, staging: { parent: "production" } } }`,
			),
		});
		const result = await runStatus({}, { cwd: root, api });
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("Plan (would apply");
		expect(result.stdout).toContain("[branch:staging] create");
	});

	test("makes no API mutations", async () => {
		const { api, projectId } = seededFake();
		const root = setup({
			"package.json": "{}",
			".neon/project.json": JSON.stringify({ projectId }),
			"neon.ts": neonTsBody(
				`{ project: { name: "cli-test", region: "aws-us-east-1" }, branches: { production: {}, staging: { parent: "production" } } }`,
			),
		});
		await runStatus({}, { cwd: root, api });
		const mutations = api.history.filter((h) =>
			[
				"createBranch",
				"updateBranch",
				"updateEndpoint",
				"createProject",
				"updateProject",
			].includes(h.method),
		);
		expect(mutations).toHaveLength(0);
	});

	test("reports a region conflict (hard-blocked, immutable on Neon)", async () => {
		const { api, projectId } = seededFake();
		const root = setup({
			"package.json": "{}",
			".neon/project.json": JSON.stringify({ projectId }),
			"neon.ts": neonTsBody(
				`{ project: { name: "cli-test", region: "aws-eu-central-1" }, branches: { production: {} } }`,
			),
		});
		const result = await runStatus({}, { cwd: root, api });
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("Conflicts (would block push)");
		expect(result.stdout).toContain("[project:");
		expect(result.stdout).toContain("region");
		expect(result.stdout).toContain("aws-us-east-1 → aws-eu-central-1");
	});

	test("reports compute drift as a ~ update under Plan (not as a conflict)", async () => {
		const { api, projectId } = seededFake();
		const root = setup({
			"package.json": "{}",
			".neon/project.json": JSON.stringify({ projectId }),
			"neon.ts": neonTsBody(
				`{ project: { name: "cli-test", region: "aws-us-east-1" }, branches: { production: { computeSettings: { autoscalingLimitMaxCu: 4 } } } }`,
			),
		});
		const result = await runStatus({}, { cwd: root, api });
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("Plan");
		expect(result.stdout).toContain("[branch:production] update");
		expect(result.stdout).toContain("computeSettings");
		expect(result.stdout).not.toContain("Conflicts");
	});

	test("missing config file → exit 4 (ConfigLoadError)", async () => {
		const { api, projectId } = seededFake();
		const root = setup({
			"package.json": "{}",
			".neon/project.json": JSON.stringify({ projectId }),
		});
		const result = await runStatus({}, { cwd: root, api });
		expect(result.exitCode).toBe(4);
		expect(result.stderr).toContain("Failed to load config");
	});

	test("reports `features.auth` / `features.dataApi` as + enable steps when not enabled remotely", async () => {
		const { api, projectId } = seededFake();
		const root = setup({
			"package.json": "{}",
			".neon/project.json": JSON.stringify({ projectId }),
			"neon.ts": neonTsBody(
				`{ project: { name: "cli-test", region: "aws-us-east-1" }, branches: { production: {} }, features: { auth: true, dataApi: true } }`,
			),
		});
		const result = await runStatus({}, { cwd: root, api });
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("Plan (would apply");
		expect(result.stdout).toContain("[feature:auth] enable");
		expect(result.stdout).toContain("[feature:dataApi] enable");
		expect(result.stdout).toContain("branchName=production");
		expect(result.stdout).toContain("databaseName=neondb");
	});

	test("noop when features are already enabled on Neon", async () => {
		const { api, projectId } = seededFake();
		// The seeded fake's auto-created branches don't carry an integration; pre-enable
		// them so the diff has nothing to do.
		const branches = await api.listBranches(projectId);
		const prod = branches.find((b) => b.name === "production");
		if (!prod) throw new Error("seed fixture lost the production branch");
		await api.enableNeonAuth(projectId, prod.id);
		await api.enableProjectBranchDataApi(projectId, prod.id, "neondb");
		const root = setup({
			"package.json": "{}",
			".neon/project.json": JSON.stringify({ projectId }),
			"neon.ts": neonTsBody(
				`{ project: { name: "cli-test", region: "aws-us-east-1" }, branches: { production: {} }, features: { auth: true, dataApi: true } }`,
			),
		});
		const result = await runStatus({}, { cwd: root, api });
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("in sync");
		expect(result.stdout).not.toContain("[feature:");
	});
});
