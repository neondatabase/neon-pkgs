import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { branch } from "./branch.js";
import * as branchNameModule from "./branch-name.js";
import { ErrorCode } from "./errors.js";
import { FakeNeonApi } from "./fake-neon-api.js";
import { makeTempRepo, stubCleanNeonEnv } from "./test-utils.js";

const PLATFORM_SRC = new URL("../v1.ts", import.meta.url).pathname;
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

function seededFake() {
	const api = new FakeNeonApi();
	const projectId = "proj-branch";
	const orgId = "org-branch";
	api.seedProject({
		project: {
			id: projectId,
			name: "branch-test",
			regionId: "aws-us-east-1",
			pgVersion: 17,
			orgId,
		},
		branches: [
			{ branch: { id: "br-main", name: "main", isDefault: true } },
		],
	});
	return { api, projectId, orgId };
}

function policy(): string {
	return `
import { defineConfig } from "${PLATFORM_SRC}";
export default defineConfig((branch) => {
  if (branch.name === "main") {
    return { protected: true, auth: {} };
  }
  return {
    parent: "main",
    ttl: "1h",
    postgres: { computeSettings: { autoscalingLimitMaxCu: 2 } },
    auth: {},
    dataApi: {},
  };
});
`;
}

describe("branch", () => {
	test("always creates a new branch from the requested name pattern and updates context", async () => {
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
		vi.spyOn(branchNameModule, "generateMiniId").mockReturnValue("abc123");

		const result = await branch({
			name: "dev",
			cwd: root,
			api,
			gitBranch: null,
		});

		expect(result.branchName).toBe("dev-abc123");
		expect(result.pattern).toBe("dev-*");
		expect(result.parentBranchName).toBe("main");
		expect(result.expiresAt).toBeDefined();
		expect(result.contextFile.status).toBe("updated");
		const createCall = api.history.find((h) => h.method === "createBranch");
		expect(createCall?.args[1]).toMatchObject({
			name: "dev-abc123",
			parentId: "br-main",
			computeSettings: { autoscalingLimitMaxCu: 2 },
		});
		expect(api.history.some((h) => h.method === "enableNeonAuth")).toBe(
			true,
		);
		expect(
			api.history.some((h) => h.method === "enableProjectBranchDataApi"),
		).toBe(true);
		const reread = JSON.parse(
			readFileSync(join(root, ".neon", "project.json"), "utf-8"),
		);
		expect(reread.branchId).toBe(result.branchId);
	});

	test("uses wildcard input verbatim", async () => {
		const { api, projectId } = seededFake();
		const root = setup({
			"package.json": "{}",
			".neon/project.json": JSON.stringify({ projectId }),
			"neon.ts": policy(),
		});
		vi.spyOn(branchNameModule, "generateMiniId").mockReturnValue("def456");

		const result = await branch({
			name: "preview-*",
			cwd: root,
			api,
			gitBranch: "feat/x",
		});

		expect(result.pattern).toBe("preview-*");
		expect(result.branchName).toBe("preview-feat-x-def456");
	});

	test("uses bare wildcard when name is empty", async () => {
		const { api, projectId } = seededFake();
		const root = setup({
			"package.json": "{}",
			".neon/project.json": JSON.stringify({ projectId }),
			"neon.ts": policy(),
		});
		vi.spyOn(branchNameModule, "generateMiniId").mockReturnValue("abc123");

		const result = await branch({
			name: "",
			cwd: root,
			api,
			gitBranch: "feat/empty-name",
		});

		expect(result.pattern).toBe("*");
		expect(result.branchName).toBe("feat-empty-name-abc123");
	});

	test("fails when policy parent does not exist", async () => {
		const { api, projectId } = seededFake();
		const root = setup({
			"package.json": "{}",
			".neon/project.json": JSON.stringify({ projectId }),
			"neon.ts": `import { defineConfig } from "${PLATFORM_SRC}"; export default defineConfig(() => ({ parent: "missing" }));`,
		});
		await expect(
			branch({ name: "dev", cwd: root, api, gitBranch: null }),
		).rejects.toMatchObject({
			code: ErrorCode.MissingParentBranch,
		});
	});
});
