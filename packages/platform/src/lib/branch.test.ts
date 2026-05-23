import { chmodSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { branch } from "./branch.js";
import {
	ConfigLoadError,
	ErrorCode,
	MissingContextError,
	PlatformError,
} from "./errors.js";
import { FakeNeonApi } from "./fake-neon-api.js";
import { makeTempRepo } from "./test-utils.js";

const PLATFORM_SRC = new URL("../v1.ts", import.meta.url).pathname;

const cleanups: Array<() => void> = [];
afterEach(() => {
	while (cleanups.length > 0) cleanups.shift()?.();
});

function setup(files: Record<string, string | null>) {
	const repo = makeTempRepo(files);
	cleanups.push(repo.cleanup);
	return repo.root;
}

interface SeededFake {
	api: FakeNeonApi;
	projectId: string;
	orgId: string;
}

/**
 * Build a fake project with `production` as the default branch — the parent every test
 * blueprint references.
 */
function seededFake(): SeededFake {
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
			{
				branch: {
					id: "br-production",
					name: "production",
					isDefault: true,
				},
			},
		],
	});
	return { api, projectId, orgId };
}

function previewBlueprint(): string {
	return `
import { defineConfig } from "${PLATFORM_SRC}";
export default defineConfig({
  project: { name: "branch-test", region: "aws-us-east-1" },
  branchBlueprints: {
    production: {},
    preview: { pattern: "preview-*", ttl: "1h", parent: "production" },
  },
});
`;
}

describe("branch — happy path", () => {
	test("creates a branch from the wildcard pattern + mini-id (no git)", async () => {
		const { api, projectId, orgId } = seededFake();
		const root = setup({
			"package.json": "{}",
			".neon/project.json": JSON.stringify({ projectId, orgId }),
			"neon.ts": previewBlueprint(),
		});

		const result = await branch({
			blueprint: "preview",
			cwd: root,
			env: {},
			api,
			gitBranch: null,
			generateMiniId: () => "abc123",
		});

		expect(result.projectId).toBe(projectId);
		expect(result.orgId).toBe(orgId);
		expect(result.branchName).toBe("preview-abc123");
		expect(result.blueprintKey).toBe("preview");
		expect(result.blueprintPattern).toBe("preview-*");
		expect(result.parentBranchName).toBe("production");
		expect(result.parentBranchId).toBe("br-production");
		expect(result.expiresAt).toBeDefined();
		expect(result.branchId).toMatch(/^br-/);

		// Verify the API was actually called with the parent + ttl.
		const createCall = api.history.find((h) => h.method === "createBranch");
		expect(createCall).toBeDefined();
		expect(createCall?.args[1]).toMatchObject({
			name: "preview-abc123",
			parentId: "br-production",
			expiresAt: expect.any(String),
		});
	});

	test("includes the normalized git branch in the name when git provided", async () => {
		const { api, projectId, orgId } = seededFake();
		const root = setup({
			"package.json": "{}",
			".neon/project.json": JSON.stringify({ projectId, orgId }),
			"neon.ts": previewBlueprint(),
		});

		const result = await branch({
			blueprint: "preview",
			cwd: root,
			env: {},
			api,
			gitBranch: "andrelandgraf/new-feature",
			generateMiniId: () => "abc123",
		});

		expect(result.branchName).toBe(
			"preview-andrelandgraf-new-feature-abc123",
		);
	});

	test("updates .neon/project.json branchId in place when a file exists", async () => {
		const { api, projectId, orgId } = seededFake();
		const root = setup({
			"package.json": "{}",
			".neon/project.json": JSON.stringify({
				projectId,
				orgId,
				branchId: "br-stale",
				neonctlMeta: "preserved",
			}),
			"neon.ts": previewBlueprint(),
		});

		const result = await branch({
			blueprint: "preview",
			cwd: root,
			env: {},
			api,
			gitBranch: null,
			generateMiniId: () => "abc123",
		});

		expect(result.contextFile.status).toBe("updated");
		if (result.contextFile.status === "updated") {
			expect(result.contextFile.path).toBe(
				join(root, ".neon", "project.json"),
			);
		}

		const reread = JSON.parse(
			readFileSync(join(root, ".neon", "project.json"), "utf-8"),
		);
		expect(reread.branchId).toBe(result.branchId);
		expect(reread.projectId).toBe(projectId);
		expect(reread.neonctlMeta).toBe("preserved");
	});

	test("updates a .neon (neonctl-style) file in place", async () => {
		const { api, projectId, orgId } = seededFake();
		const root = setup({
			"package.json": "{}",
			".neon": JSON.stringify({ projectId, orgId }),
			"neon.ts": previewBlueprint(),
		});

		const result = await branch({
			blueprint: "preview",
			cwd: root,
			env: {},
			api,
			gitBranch: null,
			generateMiniId: () => "abc123",
		});

		expect(result.contextFile.status).toBe("updated");
		if (result.contextFile.status === "updated") {
			expect(result.contextFile.path).toBe(join(root, ".neon"));
		}
		const reread = JSON.parse(readFileSync(join(root, ".neon"), "utf-8"));
		expect(reread.branchId).toBe(result.branchId);
	});

	test("returns JSON payload but does NOT create a file when none exists", async () => {
		const { api, projectId, orgId } = seededFake();
		const root = setup({
			"package.json": "{}",
			"neon.ts": previewBlueprint(),
		});

		const result = await branch({
			blueprint: "preview",
			projectId,
			orgId,
			cwd: root,
			env: {},
			api,
			gitBranch: null,
			generateMiniId: () => "abc123",
		});

		expect(result.contextFile.status).toBe("no-file");
		expect(result.contextFile.data).toEqual({
			projectId,
			orgId,
			branchId: result.branchId,
		});

		const parsed = JSON.parse(result.contextFile.json);
		expect(parsed.projectId).toBe(projectId);
		expect(parsed.branchId).toBe(result.branchId);
	});

	test("surfaces write-failed instead of throwing when the FS is read-only", async () => {
		const { api, projectId, orgId } = seededFake();
		const original = JSON.stringify({
			projectId,
			orgId,
			branchId: "br-stale",
		});
		const root = setup({
			"package.json": "{}",
			".neon/project.json": original,
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

		const result = await branch({
			blueprint: "preview",
			cwd: root,
			env: {},
			api,
			gitBranch: null,
			generateMiniId: () => "abc123",
		});

		expect(result.contextFile.status).toBe("write-failed");
		if (result.contextFile.status === "write-failed") {
			expect(result.contextFile.path).toBe(filePath);
			expect(result.contextFile.error).toMatch(
				/EACCES|permission denied/i,
			);
			expect(result.contextFile.json).toContain(
				`"branchId": "${result.branchId}"`,
			);
		}
		// And critically: the branch was still created on Neon.
		expect(result.branchId).toMatch(/^br-/);
		// The on-disk file was not modified (still has the stale branchId).
		const reread = readFileSync(filePath, "utf-8");
		expect(reread).toBe(original);
	});

	test("iterates on the mini-id when the generated name collides", async () => {
		const api = new FakeNeonApi();
		const projectId = "proj-collide";
		api.seedProject({
			project: {
				id: projectId,
				name: "branch-test",
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
						id: "br-existing",
						name: "preview-abc123",
						isDefault: false,
						parentId: "br-prod",
					},
				},
			],
		});

		const root = setup({
			"package.json": "{}",
			".neon/project.json": JSON.stringify({ projectId }),
			"neon.ts": previewBlueprint(),
		});

		let call = 0;
		const result = await branch({
			blueprint: "preview",
			cwd: root,
			env: {},
			api,
			gitBranch: null,
			generateMiniId: () => {
				call += 1;
				return call === 1 ? "abc123" : "def456";
			},
		});

		expect(result.branchName).toBe("preview-def456");
		expect(call).toBe(2);
	});
});

describe("branch — error paths", () => {
	test("throws ConfigLoadError when neon.ts is missing", async () => {
		const { api, projectId } = seededFake();
		const root = setup({
			"package.json": "{}",
			".neon/project.json": JSON.stringify({ projectId }),
		});
		await expect(
			branch({
				blueprint: "preview",
				cwd: root,
				env: {},
				api,
				gitBranch: null,
			}),
		).rejects.toBeInstanceOf(ConfigLoadError);
	});

	test("throws MissingContextError when no project context is resolvable", async () => {
		const { api } = seededFake();
		const root = setup({
			"package.json": "{}",
			"neon.ts": previewBlueprint(),
		});
		await expect(
			branch({
				blueprint: "preview",
				cwd: root,
				env: {},
				api,
				gitBranch: null,
			}),
		).rejects.toBeInstanceOf(MissingContextError);
	});

	test("throws NotFound when the blueprint name is unknown", async () => {
		const { api, projectId } = seededFake();
		const root = setup({
			"package.json": "{}",
			".neon/project.json": JSON.stringify({ projectId }),
			"neon.ts": previewBlueprint(),
		});
		await expect(
			branch({
				blueprint: "does-not-exist",
				cwd: root,
				env: {},
				api,
				gitBranch: null,
			}),
		).rejects.toMatchObject({
			code: ErrorCode.NotFound,
		});
	});

	test("throws InvalidConfig when the blueprint pattern is not a wildcard", async () => {
		const { api, projectId } = seededFake();
		const root = setup({
			"package.json": "{}",
			".neon/project.json": JSON.stringify({ projectId }),
			"neon.ts": previewBlueprint(),
		});
		await expect(
			branch({
				blueprint: "production", // specific name — not for `branch`
				cwd: root,
				env: {},
				api,
				gitBranch: null,
			}),
		).rejects.toMatchObject({
			code: ErrorCode.InvalidConfig,
		});
	});

	test("throws MissingParentBranch when parent doesn't exist on remote", async () => {
		// Fake project with NO production branch, just main.
		const api = new FakeNeonApi();
		const projectId = "proj-no-parent";
		api.seedProject({
			project: {
				id: projectId,
				name: "branch-test",
				regionId: "aws-us-east-1",
				pgVersion: 17,
			},
			branches: [
				{
					branch: {
						id: "br-main",
						name: "main",
						isDefault: true,
					},
				},
			],
		});

		const root = setup({
			"package.json": "{}",
			".neon/project.json": JSON.stringify({ projectId }),
			"neon.ts": previewBlueprint(),
		});

		await expect(
			branch({
				blueprint: "preview",
				cwd: root,
				env: {},
				api,
				gitBranch: null,
			}),
		).rejects.toMatchObject({
			code: ErrorCode.MissingParentBranch,
		});
	});

	test("throws InternalError when the mini-id generator never produces a unique name", async () => {
		const { api, projectId } = seededFake();
		const root = setup({
			"package.json": "{}",
			".neon/project.json": JSON.stringify({ projectId }),
			"neon.ts": previewBlueprint(),
		});
		// Same id every call: existence check fails forever.
		api.history.length = 0;
		// Pre-seed a collision so the first attempt collides.
		await api.createBranch(projectId, {
			name: "preview-stuck",
			parentId: "br-production",
		});

		await expect(
			branch({
				blueprint: "preview",
				cwd: root,
				env: {},
				api,
				gitBranch: null,
				generateMiniId: () => "stuck",
				maxAttempts: 3,
			}),
		).rejects.toMatchObject({
			code: ErrorCode.InternalError,
		});
	});

	test("missing api key + no neonctl creds → MissingApiKey error", async () => {
		const emptyHome = setup({ ".config/neonctl/.keep": "" });
		const root = setup({
			"package.json": "{}",
			".neon/project.json": JSON.stringify({ projectId: "p1" }),
			"neon.ts": previewBlueprint(),
		});
		await expect(
			branch({
				blueprint: "preview",
				cwd: root,
				env: { HOME: emptyHome, USERPROFILE: emptyHome },
				gitBranch: null,
			}),
		).rejects.toMatchObject({
			code: ErrorCode.MissingApiKey,
		});
	});
});

describe("branch — option overrides win over env / file", () => {
	test("options.projectId overrides env and file", async () => {
		const { api, projectId } = seededFake();
		const root = setup({
			"package.json": "{}",
			".neon/project.json": JSON.stringify({ projectId: "from-file" }),
			"neon.ts": previewBlueprint(),
		});

		const result = await branch({
			blueprint: "preview",
			projectId,
			cwd: root,
			env: { NEON_PROJECT_ID: "from-env" },
			api,
			gitBranch: null,
			generateMiniId: () => "abc123",
		});

		expect(result.projectId).toBe(projectId);
	});

	test("respects PlatformError instance check", async () => {
		const { api, projectId } = seededFake();
		const root = setup({
			"package.json": "{}",
			".neon/project.json": JSON.stringify({ projectId }),
			"neon.ts": previewBlueprint(),
		});
		await expect(
			branch({
				blueprint: "does-not-exist",
				cwd: root,
				env: {},
				api,
				gitBranch: null,
			}),
		).rejects.toBeInstanceOf(PlatformError);
	});
});
