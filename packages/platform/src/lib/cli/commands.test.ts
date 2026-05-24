import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { FakeNeonApi } from "../fake-neon-api.js";
import { makeTempRepo, stubCleanNeonEnv } from "../test-utils.js";
import {
	runBranch,
	runCheckout,
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
export default defineConfig((branch) => branch.name === "main" ? { auth: { enabled: true } } : { parent: "main", ttl: "1h" });`;
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
			{ cwd: root, api },
		);
		expect(result.exitCode).toBe(0);
		expect(existsSync(join(root, "neon.ts"))).toBe(true);
		expect(readFileSync(join(root, "neon.ts"), "utf-8")).toContain(
			"defineConfig((branch)",
		);
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
		expect(result.stdout).toContain("[feature:auth] enable");
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
