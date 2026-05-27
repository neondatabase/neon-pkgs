import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { FakeNeonApi } from "../fake-neon-api.js";
import { makeTempRepo, stubCleanNeonEnv } from "../test-utils.js";
import {
	runBranch,
	runCheckout,
	runEnvPull,
	runInit,
	runPull,
	runPush,
	runStatus,
} from "./commands.js";

const PLATFORM_SRC = new URL("../../v1.ts", import.meta.url).pathname;
const cleanups: Array<() => void> = [];

afterEach(() => {
	while (cleanups.length > 0) cleanups.shift()?.();
});
beforeEach(() => stubCleanNeonEnv());

function setup(files: Record<string, string | null>) {
	const repo = makeTempRepo(files);
	cleanups.push(repo.cleanup);
	return repo.root;
}

function seededFake() {
	const api = new FakeNeonApi();
	const projectId = "proj-cli";
	const orgId = "org-cli";
	api.seedProject({
		project: {
			id: projectId,
			name: "cli-test",
			regionId: "aws-us-east-1",
			pgVersion: 17,
			orgId,
		},
		branches: [
			{ branch: { id: "br-main", name: "main", isDefault: true } },
			{
				branch: {
					id: "br-dev",
					name: "dev-a",
					isDefault: false,
					parentId: "br-main",
				},
			},
		],
	});
	return { api, projectId, orgId };
}

function policy() {
	return `import { defineConfig } from "${PLATFORM_SRC}";
export default defineConfig((branch) => branch.name === "main" ? { auth: { enabled: true } } : { parent: "main", ttl: "1h", auth: {} });`;
}

function noopPlatformInstall() {
	return Promise.resolve({
		installed: false,
		skipped: true,
		message: "Skipped platform install in tests.",
	});
}

describe("runPull / runInit", () => {
	test("pull prints selected branch JSON", async () => {
		const { api, projectId } = seededFake();
		const root = setup({ "package.json": "{}" });
		const result = await runPull(
			{ projectId, branch: "dev-a" },
			{ cwd: root, api },
		);
		expect(result.exitCode).toBe(0);
		expect(JSON.parse(result.stdout).branch.name).toBe("dev-a");
	});

	test("init writes a starter neon.ts", async () => {
		const { api, projectId } = seededFake();
		const root = setup({ "package.json": "{}" });
		const result = await runInit(
			{ projectId, branch: "main" },
			{ cwd: root, api, ensurePlatformPackage: noopPlatformInstall },
		);
		expect(result.exitCode).toBe(0);
		expect(existsSync(join(root, "neon.ts"))).toBe(true);
		expect(readFileSync(join(root, "neon.ts"), "utf-8")).toContain(
			"defineConfig((branch)",
		);
	});

	test("init reports successful package install before writing neon.ts", async () => {
		const { api, projectId } = seededFake();
		const root = setup({ "package.json": "{}" });
		const result = await runInit(
			{ projectId, branch: "main" },
			{
				cwd: root,
				api,
				ensurePlatformPackage: async () => ({
					installed: true,
					skipped: false,
					message: "Installed @neondatabase/platform with pnpm.",
				}),
			},
		);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("Installed @neondatabase/platform");
		expect(result.stdout).toContain("Created");
	});

	test("init fails when platform package install fails", async () => {
		const { api, projectId } = seededFake();
		const root = setup({ "package.json": "{}" });
		const result = await runInit(
			{ projectId, branch: "main" },
			{
				cwd: root,
				api,
				ensurePlatformPackage: async () => ({
					installed: false,
					skipped: false,
					message: "install failed",
				}),
			},
		);
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("install failed");
		expect(existsSync(join(root, "neon.ts"))).toBe(false);
	});
});

describe("runBranch / runCheckout", () => {
	test("branch creates and updates context", async () => {
		const { api, projectId, orgId } = seededFake();
		const root = setup({
			"package.json": "{}",
			".neon/project.json": JSON.stringify({
				projectId,
				orgId,
				branchId: "br-main",
			}),
			"neon.ts": policy(),
		});
		const result = await runBranch({ name: "dev" }, { cwd: root, api });
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("created branch dev-");
		const reread = JSON.parse(
			readFileSync(join(root, ".neon", "project.json"), "utf-8"),
		);
		expect(reread.branchId).not.toBe("br-main");
		expect(readFileSync(join(root, ".env.local"), "utf-8")).toContain(
			"NEON_AUTH_BASE_URL=https://api.fake.neon.tech/auth/",
		);
	});

	test("env pull from a package reuses auth keys captured at branch creation", async () => {
		const { api, projectId, orgId } = seededFake();
		const root = setup({
			"package.json": "{}",
			"packages/db/package.json": "{}",
			".neon/project.json": JSON.stringify({
				projectId,
				orgId,
				branchId: "br-main",
			}),
			"neon.ts": policy(),
		});
		const nested = join(root, "packages", "db");

		const branchResult = await runBranch(
			{ name: "dev" },
			{ cwd: root, api },
		);
		expect(branchResult.exitCode).toBe(0);
		const pullResult = await runEnvPull({}, { cwd: nested, api });

		expect(pullResult.exitCode).toBe(0);
		expect(pullResult.stdout).toContain(
			`Updated ${join(root, ".env.local")}`,
		);
		const envFile = readFileSync(join(root, ".env.local"), "utf-8");
		expect(envFile).toContain("DATABASE_URL=");
		expect(envFile).toContain("DATABASE_URL_UNPOOLED=");
		expect(envFile).toContain(
			"NEON_AUTH_BASE_URL=https://api.fake.neon.tech/auth/",
		);
	});

	test("branch accepts no name and creates from the bare wildcard", async () => {
		const { api, projectId } = seededFake();
		const root = setup({
			"package.json": "{}",
			".neon/project.json": JSON.stringify({
				projectId,
				branchId: "br-main",
			}),
			"neon.ts": policy(),
		});
		const result = await runBranch({ name: "" }, { cwd: root, api });
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("pattern   : *");
		expect(result.stdout).toContain("created branch");
	});

	test("checkout selects an existing branch", async () => {
		const { api, projectId } = seededFake();
		const root = setup({
			"package.json": "{}",
			".neon/project.json": JSON.stringify({
				projectId,
				branchId: "br-main",
			}),
		});
		const result = await runCheckout(
			{ branch: "dev-a" },
			{ cwd: root, api },
		);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("checked out branch dev-a (br-dev)");
		const reread = JSON.parse(
			readFileSync(join(root, ".neon", "project.json"), "utf-8"),
		);
		expect(reread.branchId).toBe("br-dev");
	});
});

describe("runPush / runStatus", () => {
	test("push applies selected branch policy", async () => {
		const { api, projectId } = seededFake();
		const root = setup({
			"package.json": "{}",
			".neon/project.json": JSON.stringify({
				projectId,
				branchId: "br-main",
			}),
			"neon.ts": policy(),
		});
		const result = await runPush({}, { cwd: root, api });
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("branch main (br-main)");
		expect(result.stdout).toContain("[service:auth] enable");
	});

	test("push prompts and applies when user confirms an override", async () => {
		const { api, projectId } = seededFake();
		// Pre-create a drift on the read-write endpoint so the policy below requests
		// an override the user has to confirm.
		const root = setup({
			"package.json": "{}",
			".neon/project.json": JSON.stringify({
				projectId,
				branchId: "br-main",
			}),
			"neon.ts": `import { defineConfig } from "${PLATFORM_SRC}";\nexport default defineConfig(() => ({ postgres: { computeSettings: { autoscalingLimitMaxCu: 4 } } }));`,
		});
		const prompts: string[] = [];
		const result = await runPush(
			{},
			{
				cwd: root,
				api,
				confirmPrompt: async (msg) => {
					prompts.push(msg);
					return true;
				},
			},
		);
		expect(result.exitCode).toBe(0);
		expect(prompts).toHaveLength(1);
		expect(prompts[0]).toContain("override existing remote settings");
		expect(api.history.some((h) => h.method === "updateEndpoint")).toBe(
			true,
		);
	});

	test("push aborts with non-zero exit when user declines", async () => {
		const { api, projectId } = seededFake();
		const root = setup({
			"package.json": "{}",
			".neon/project.json": JSON.stringify({
				projectId,
				branchId: "br-main",
			}),
			"neon.ts": `import { defineConfig } from "${PLATFORM_SRC}";\nexport default defineConfig(() => ({ postgres: { computeSettings: { autoscalingLimitMaxCu: 4 } } }));`,
		});
		const result = await runPush(
			{},
			{
				cwd: root,
				api,
				confirmPrompt: async () => false,
			},
		);
		expect(result.exitCode).toBe(12);
		expect(result.stderr).toContain("Aborted push");
		expect(api.history.some((h) => h.method === "updateEndpoint")).toBe(
			false,
		);
	});

	test("push collapses protected branch + override drift into a single prompt", async () => {
		const api = new FakeNeonApi();
		const projectId = "proj-cli-prot";
		api.seedProject({
			project: {
				id: projectId,
				name: "cli-prot",
				regionId: "aws-us-east-1",
				pgVersion: 17,
			},
			branches: [
				{
					branch: {
						id: "br-main",
						name: "main",
						isDefault: true,
						protected: true,
					},
				},
			],
		});
		const root = setup({
			"package.json": "{}",
			".neon/project.json": JSON.stringify({
				projectId,
				branchId: "br-main",
			}),
			"neon.ts": `import { defineConfig } from "${PLATFORM_SRC}";\nexport default defineConfig(() => ({ postgres: { computeSettings: { autoscalingLimitMaxCu: 4 } } }));`,
		});
		const prompts: string[] = [];
		const result = await runPush(
			{},
			{
				cwd: root,
				api,
				confirmPrompt: async (msg) => {
					prompts.push(msg);
					return true;
				},
			},
		);
		expect(result.exitCode).toBe(0);
		expect(prompts).toHaveLength(1);
		expect(prompts[0]).toContain("protected");
		expect(prompts[0]).toContain("override existing remote settings");
	});

	test("--allow-protected-branch + --update-existing skip the prompt entirely", async () => {
		const api = new FakeNeonApi();
		const projectId = "proj-cli-prot2";
		api.seedProject({
			project: {
				id: projectId,
				name: "cli-prot2",
				regionId: "aws-us-east-1",
				pgVersion: 17,
			},
			branches: [
				{
					branch: {
						id: "br-main",
						name: "main",
						isDefault: true,
						protected: true,
					},
				},
			],
		});
		const root = setup({
			"package.json": "{}",
			".neon/project.json": JSON.stringify({
				projectId,
				branchId: "br-main",
			}),
			"neon.ts": `import { defineConfig } from "${PLATFORM_SRC}";\nexport default defineConfig(() => ({ postgres: { computeSettings: { autoscalingLimitMaxCu: 4 } } }));`,
		});
		let calls = 0;
		const result = await runPush(
			{ allowProtectedBranch: true, updateExisting: true },
			{
				cwd: root,
				api,
				confirmPrompt: async () => {
					calls++;
					return true;
				},
			},
		);
		expect(result.exitCode).toBe(0);
		expect(calls).toBe(0);
		expect(api.history.some((h) => h.method === "updateEndpoint")).toBe(
			true,
		);
	});

	test("status is a dry run", async () => {
		const { api, projectId } = seededFake();
		const root = setup({
			"package.json": "{}",
			".neon/project.json": JSON.stringify({
				projectId,
				branchId: "br-main",
			}),
			"neon.ts": policy(),
		});
		const result = await runStatus({}, { cwd: root, api });
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("Status against project");
		expect(api.history.some((h) => h.method === "enableNeonAuth")).toBe(
			false,
		);
	});
});
