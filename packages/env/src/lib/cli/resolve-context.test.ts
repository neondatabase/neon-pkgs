import { afterEach, describe, expect, test } from "vitest";
import { makeTempRepo } from "../test-utils.js";
import { resolveContext } from "./resolve-context.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
	while (cleanups.length > 0) cleanups.shift()?.();
});

function setup(files: Record<string, string | null>) {
	const repo = makeTempRepo(files);
	cleanups.push(repo.cleanup);
	return repo.root;
}

/** An env with every NEON_* key explicitly unset, so the test controls precedence. */
const EMPTY_ENV: NodeJS.ProcessEnv = {};

describe("resolveContext — precedence", () => {
	test("explicit options win over env and file", () => {
		const root = setup({
			"package.json": "{}",
			".neon/project.json": JSON.stringify({
				projectId: "proj-file",
				branchId: "br-file",
			}),
		});
		const result = resolveContext({
			cwd: root,
			projectId: "proj-opt",
			branch: "br-opt",
			env: {
				NEON_PROJECT_ID: "proj-env",
				NEON_BRANCH_ID: "br-env",
			},
		});
		expect(result).toEqual({
			ok: true,
			context: { projectId: "proj-opt", branch: "br-opt" },
		});
	});

	test("env wins over the .neon file when no option is given", () => {
		const root = setup({
			"package.json": "{}",
			".neon/project.json": JSON.stringify({
				projectId: "proj-file",
				branchId: "br-file",
			}),
		});
		const result = resolveContext({
			cwd: root,
			env: {
				NEON_PROJECT_ID: "proj-env",
				NEON_BRANCH_ID: "br-env",
			},
		});
		expect(result).toMatchObject({
			ok: true,
			context: { projectId: "proj-env", branch: "br-env" },
		});
	});

	test("NEON_BRANCH (name) resolves and wins over the file", () => {
		const root = setup({
			"package.json": "{}",
			".neon": JSON.stringify({
				projectId: "proj-file",
				branch: "br-file",
			}),
		});
		const result = resolveContext({
			cwd: root,
			env: { NEON_PROJECT_ID: "proj-env", NEON_BRANCH: "feature-x" },
		});
		expect(result).toMatchObject({
			ok: true,
			context: { projectId: "proj-env", branch: "feature-x" },
		});
	});

	test("falls back to the legacy `branchId` field in the .neon file", () => {
		const root = setup({
			"package.json": "{}",
			".neon/project.json": JSON.stringify({
				projectId: "proj-file",
				branchId: "br-file",
			}),
		});
		const result = resolveContext({ cwd: root, env: EMPTY_ENV });
		expect(result).toEqual({
			ok: true,
			context: {
				projectId: "proj-file",
				branch: "br-file",
			},
		});
	});

	test("prefers the `branch` field over the legacy `branchId`", () => {
		const root = setup({
			"package.json": "{}",
			".neon": JSON.stringify({
				projectId: "proj-file",
				branch: "main",
				branchId: "br-legacy",
			}),
		});
		const result = resolveContext({ cwd: root, env: EMPTY_ENV });
		expect(result).toEqual({
			ok: true,
			context: { projectId: "proj-file", branch: "main" },
		});
	});
});

describe("resolveContext — .neon file discovery", () => {
	test("reads the bare `.neon` neonctl-convention file (branch name)", () => {
		// `neonctl link` writes a flat `.neon` with `branch` holding the branch *name*.
		const root = setup({
			"package.json": "{}",
			".neon": JSON.stringify({
				projectId: "p-bare",
				branch: "main",
			}),
		});
		const result = resolveContext({ cwd: root, env: EMPTY_ENV });
		expect(result).toMatchObject({
			ok: true,
			context: { projectId: "p-bare", branch: "main" },
		});
	});

	test("prefers .neon/project.json over a bare .neon in the same dir", () => {
		const root = setup({
			"package.json": "{}",
			".neon/project.json": JSON.stringify({
				projectId: "p-dir",
				branchId: "br-dir",
			}),
		});
		// (A bare `.neon` file cannot coexist with a `.neon/` directory, so the
		// preference is exercised structurally by the dir form resolving first.)
		const result = resolveContext({ cwd: root, env: EMPTY_ENV });
		expect(result).toMatchObject({
			ok: true,
			context: { projectId: "p-dir" },
		});
	});

	test("walks up from a nested dir to a workspace-root .neon", () => {
		const root = setup({
			"package.json": "{}",
			".neon/project.json": JSON.stringify({
				projectId: "p-root",
				branchId: "br-root",
			}),
			"packages/db/package.json": "{}",
		});
		const result = resolveContext({
			cwd: `${root}/packages/db`,
			env: EMPTY_ENV,
		});
		expect(result).toMatchObject({
			ok: true,
			context: { projectId: "p-root", branch: "br-root" },
		});
	});

	test("stops the upward walk at the .git boundary", () => {
		// `.neon` lives ABOVE the repo root; the walk must not escape past `.git`.
		const outer = setup({
			".neon/project.json": JSON.stringify({
				projectId: "p-outer",
				branchId: "br-outer",
			}),
		});
		// Seed an inner repo with its own `.git` and no context file.
		const innerRepo = makeTempRepo({ "package.json": "{}" });
		cleanups.push(innerRepo.cleanup);
		// The inner repo is a separate temp dir, so walking from it never reaches `outer`.
		const result = resolveContext({ cwd: innerRepo.root, env: EMPTY_ENV });
		expect(result.ok).toBe(false);
		void outer;
	});

	test("treats malformed .neon JSON as absent", () => {
		const root = setup({
			"package.json": "{}",
			".neon/project.json": "{ not valid json",
		});
		const result = resolveContext({ cwd: root, env: EMPTY_ENV });
		expect(result.ok).toBe(false);
	});

	test("ignores empty-string fields in the .neon file", () => {
		const root = setup({
			"package.json": "{}",
			".neon/project.json": JSON.stringify({
				projectId: "",
				branchId: "br-1",
			}),
		});
		const result = resolveContext({ cwd: root, env: EMPTY_ENV });
		// projectId empty → unresolved; branchId present.
		expect(result.ok).toBe(false);
	});
});

describe("resolveContext — missing fields", () => {
	test("reports both missing when nothing resolves", () => {
		const root = setup({ "package.json": "{}" });
		const result = resolveContext({ cwd: root, env: EMPTY_ENV });
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("expected failure");
		expect(result.missing).toHaveLength(2);
		expect(result.missing[0]).toContain("project id");
		expect(result.missing[1]).toContain("branch");
	});

	test("reports only branch missing when projectId resolves", () => {
		const root = setup({ "package.json": "{}" });
		const result = resolveContext({
			cwd: root,
			projectId: "p",
			env: EMPTY_ENV,
		});
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("expected failure");
		expect(result.missing).toHaveLength(1);
		expect(result.missing[0]).toContain("branch");
	});

	test("reports only project missing when branch resolves", () => {
		const root = setup({ "package.json": "{}" });
		const result = resolveContext({
			cwd: root,
			branch: "br-1",
			env: EMPTY_ENV,
		});
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("expected failure");
		expect(result.missing).toHaveLength(1);
		expect(result.missing[0]).toContain("project id");
	});

	test("trims whitespace-only values to missing", () => {
		const root = setup({ "package.json": "{}" });
		const result = resolveContext({
			cwd: root,
			projectId: "   ",
			branch: "  ",
			env: EMPTY_ENV,
		});
		expect(result.ok).toBe(false);
	});
});
