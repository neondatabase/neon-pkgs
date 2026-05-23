import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { MissingContextError } from "./errors.js";
import { loadContext, loadContextWithBranch } from "./load-context.js";
import { makeTempRepo, stubCleanNeonEnv } from "./test-utils.js";

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

describe("loadContext — project resolution", () => {
	test("call args win over env and file", () => {
		const root = setup({
			"package.json": "{}",
			".neon/project.json": JSON.stringify({
				projectId: "from-file",
				orgId: "org-file",
			}),
		});
		vi.stubEnv("NEON_PROJECT_ID", "from-env");
		const ctx = loadContext({
			projectId: "from-args",
			orgId: "org-args",
			cwd: root,
		});
		expect(ctx.projectId).toBe("from-args");
		expect(ctx.orgId).toBe("org-args");
	});

	test("env wins over file when args missing", () => {
		const root = setup({
			"package.json": "{}",
			".neon/project.json": JSON.stringify({
				projectId: "from-file",
				orgId: "org-file",
			}),
		});
		vi.stubEnv("NEON_PROJECT_ID", "from-env");
		vi.stubEnv("NEON_ORG_ID", "org-env");
		const ctx = loadContext({ cwd: root });
		expect(ctx.projectId).toBe("from-env");
		expect(ctx.orgId).toBe("org-env");
	});

	test("falls back to file when args and env missing", () => {
		const root = setup({
			"package.json": "{}",
			".neon/project.json": JSON.stringify({
				projectId: "from-file",
				orgId: "org-file",
			}),
		});
		const ctx = loadContext({ cwd: root });
		expect(ctx.projectId).toBe("from-file");
		expect(ctx.orgId).toBe("org-file");
	});

	test("throws MissingContextError when nothing supplies a projectId", () => {
		const root = setup({ "package.json": "{}" });
		expect(() => loadContext({ cwd: root })).toThrow(MissingContextError);
	});

	test("treats empty strings as missing", () => {
		const root = setup({
			"package.json": "{}",
			".neon/project.json": JSON.stringify({ projectId: "from-file" }),
		});
		vi.stubEnv("NEON_PROJECT_ID", "");
		const ctx = loadContext({ projectId: "   ", cwd: root });
		expect(ctx.projectId).toBe("from-file");
	});
});

describe("loadContext — branch resolution", () => {
	test("uses passed branch name", () => {
		const root = setup({
			"package.json": "{}",
			".neon/project.json": JSON.stringify({
				projectId: "p1",
				branchId: "br-from-file",
			}),
		});
		vi.stubEnv("NEON_BRANCH_ID", "br-from-env");
		const ctx = loadContext({ branch: "feature-x", cwd: root });
		expect(ctx.branch).toEqual({ kind: "name", value: "feature-x" });
	});

	test("recognises a passed-in id by the br- prefix", () => {
		const root = setup({ "package.json": "{}" });
		const ctx = loadContext({
			projectId: "p1",
			branch: "br-cool-snow-12345",
			cwd: root,
		});
		expect(ctx.branch).toEqual({ kind: "id", value: "br-cool-snow-12345" });
	});

	test("falls back to NEON_BRANCH_ID env when no branch is passed", () => {
		const root = setup({
			"package.json": "{}",
			".neon/project.json": JSON.stringify({
				projectId: "p1",
				branchId: "br-from-file",
			}),
		});
		vi.stubEnv("NEON_BRANCH_ID", "br-from-env");
		const ctx = loadContext({ cwd: root });
		expect(ctx.branch).toEqual({ kind: "id", value: "br-from-env" });
	});

	test("falls back to context file branchId when no arg or env", () => {
		const root = setup({
			"package.json": "{}",
			".neon/project.json": JSON.stringify({
				projectId: "p1",
				branchId: "br-from-file",
			}),
		});
		const ctx = loadContext({ cwd: root });
		expect(ctx.branch).toEqual({ kind: "id", value: "br-from-file" });
	});

	test("branch is undefined when no source provides one", () => {
		const root = setup({
			"package.json": "{}",
			".neon/project.json": JSON.stringify({ projectId: "p1" }),
		});
		const ctx = loadContext({ cwd: root });
		expect(ctx.branch).toBeUndefined();
	});

	test("treats NEON_BRANCH_ID with empty value as missing", () => {
		const root = setup({
			"package.json": "{}",
			".neon/project.json": JSON.stringify({
				projectId: "p1",
				branchId: "br-from-file",
			}),
		});
		vi.stubEnv("NEON_BRANCH_ID", "   ");
		const ctx = loadContext({ cwd: root });
		expect(ctx.branch).toEqual({ kind: "id", value: "br-from-file" });
	});

	test("loadContextWithBranch throws when branch is missing", () => {
		const root = setup({
			"package.json": "{}",
			".neon/project.json": JSON.stringify({ projectId: "p1" }),
		});
		expect(() => loadContextWithBranch({ cwd: root })).toThrow(
			MissingContextError,
		);
	});

	test("loadContextWithBranch returns narrowed type when branch present", () => {
		const root = setup({
			"package.json": "{}",
			".neon/project.json": JSON.stringify({
				projectId: "p1",
				branchId: "br-x",
			}),
		});
		const ctx = loadContextWithBranch({ cwd: root });
		// At the type level, ctx.branch is BranchRef (non-optional). Just assert at runtime.
		expect(ctx.branch.kind).toBe("id");
		expect(ctx.branch.value).toBe("br-x");
	});
});
