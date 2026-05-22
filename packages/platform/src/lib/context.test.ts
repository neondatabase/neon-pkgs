import { afterEach, describe, expect, test } from "vitest";
import { findProjectContext, requireProjectContext } from "./context.js";
import { MissingContextError } from "./errors.js";
import { makeTempRepo } from "./test-utils.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
	while (cleanups.length > 0) {
		const fn = cleanups.shift();
		fn?.();
	}
});

function setup(files: Record<string, string | null>) {
	const repo = makeTempRepo(files);
	cleanups.push(repo.cleanup);
	return repo.root;
}

describe("findProjectContext", () => {
	test("reads .neon/project.json at cwd", () => {
		const root = setup({
			"package.json": "{}",
			".neon/project.json": JSON.stringify({
				projectId: "proj-1",
				orgId: "org-1",
			}),
		});
		const ctx = findProjectContext({ cwd: root, stopAt: root });
		expect(ctx).toMatchObject({ projectId: "proj-1", orgId: "org-1" });
		expect(ctx?.sourcePath.endsWith("/.neon/project.json")).toBe(true);
	});

	test("reads .neon file when .neon/project.json is absent", () => {
		const root = setup({
			"package.json": "{}",
			".neon": JSON.stringify({ projectId: "proj-2" }),
		});
		const ctx = findProjectContext({ cwd: root, stopAt: root });
		expect(ctx?.projectId).toBe("proj-2");
		expect(ctx?.orgId).toBeUndefined();
		expect(ctx?.sourcePath.endsWith("/.neon")).toBe(true);
	});

	test("nearer context file wins when walking up", () => {
		// `.neon` (file) at the repo root + `.neon/project.json` at a nested package would
		// shadow it; the inner one wins because the walk stops at the first directory that
		// has a context file.
		const root = setup({
			"package.json": "{}",
			".neon": JSON.stringify({ projectId: "outer" }),
			"apps/web/package.json": "{}",
			"apps/web/.neon/project.json": JSON.stringify({
				projectId: "inner",
			}),
		});
		const ctx = findProjectContext({
			cwd: `${root}/apps/web`,
			stopAt: root,
		});
		expect(ctx?.projectId).toBe("inner");
	});

	test("walks up from a subdirectory to find context", () => {
		const root = setup({
			"package.json": "{}",
			".neon/project.json": JSON.stringify({ projectId: "proj-3" }),
			"src/lib/x.ts": "// hi",
		});
		const ctx = findProjectContext({
			cwd: `${root}/src/lib`,
			stopAt: root,
		});
		expect(ctx?.projectId).toBe("proj-3");
	});

	test("stops walking at .git boundary", () => {
		const root = setup({
			"package.json": "{}",
			"inner/.git/HEAD": "",
			"inner/src/file.ts": "// hi",
		});
		const ctx = findProjectContext({
			cwd: `${root}/inner/src`,
			stopAt: root,
		});
		expect(ctx).toBeNull();
	});

	test("returns null when no context anywhere", () => {
		const root = setup({ "package.json": "{}" });
		const ctx = findProjectContext({ cwd: root, stopAt: root });
		expect(ctx).toBeNull();
	});

	test("ignores invalid JSON gracefully", () => {
		const root = setup({
			"package.json": "{}",
			".neon/project.json": "not json",
		});
		const ctx = findProjectContext({ cwd: root, stopAt: root });
		expect(ctx).toBeNull();
	});

	test("ignores files missing projectId", () => {
		const root = setup({
			"package.json": "{}",
			".neon/project.json": JSON.stringify({ orgId: "org-no-project" }),
		});
		const ctx = findProjectContext({ cwd: root, stopAt: root });
		expect(ctx).toBeNull();
	});

	test("reads branchId from the context file", () => {
		const root = setup({
			"package.json": "{}",
			".neon/project.json": JSON.stringify({
				projectId: "proj-x",
				orgId: "org-x",
				branchId: "br-stored",
			}),
		});
		const ctx = findProjectContext({ cwd: root, stopAt: root });
		expect(ctx?.branchId).toBe("br-stored");
	});
});

describe("requireProjectContext", () => {
	test("throws MissingContextError when no file is found", () => {
		const root = setup({ "package.json": "{}" });
		expect(() =>
			requireProjectContext({ cwd: root, stopAt: root }),
		).toThrow(MissingContextError);
	});

	test("never creates files on disk", () => {
		const root = setup({ "package.json": "{}" });
		expect(() =>
			requireProjectContext({ cwd: root, stopAt: root }),
		).toThrow();
		// Asserting the read-only contract: no .neon should appear.
		const repo = makeTempRepo({ "package.json": "{}" });
		cleanups.push(repo.cleanup);
		expect(() =>
			requireProjectContext({ cwd: repo.root, stopAt: repo.root }),
		).toThrow();
		const ctxAfter = findProjectContext({
			cwd: repo.root,
			stopAt: repo.root,
		});
		expect(ctxAfter).toBeNull();
	});
});
