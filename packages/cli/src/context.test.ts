import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
	applyContext,
	currentContextFile,
	ensureGitignored,
	isCurrentBranchProbe,
	walkContextFile,
} from "./context.js";

describe("isCurrentBranchProbe", () => {
	test("true only when --current-branch is set on `status` or `config`", () => {
		expect(
			isCurrentBranchProbe({ _: ["status"], currentBranch: true }),
		).toBe(true);
		expect(
			isCurrentBranchProbe({
				_: ["config", "status"],
				currentBranch: true,
			}),
		).toBe(true);
	});

	test("false without the flag", () => {
		expect(isCurrentBranchProbe({ _: ["status"] })).toBe(false);
		expect(
			isCurrentBranchProbe({
				_: ["config", "status"],
				currentBranch: false,
			}),
		).toBe(false);
	});

	test("false for unrelated commands even with the flag (no auth/analytics skip)", () => {
		expect(
			isCurrentBranchProbe({
				_: ["projects", "list"],
				currentBranch: true,
			}),
		).toBe(false);
		expect(isCurrentBranchProbe({ _: [], currentBranch: true })).toBe(
			false,
		);
	});

	test("false for other `config` subcommands even with the flag (config plan/apply)", () => {
		// `--current-branch` is undefined on these, but non-strict yargs still parses
		// it; the probe must NOT match, or `config plan` would skip auth and crash.
		expect(
			isCurrentBranchProbe({
				_: ["config", "plan"],
				currentBranch: true,
			}),
		).toBe(false);
		expect(
			isCurrentBranchProbe({
				_: ["config", "apply"],
				currentBranch: true,
			}),
		).toBe(false);
		expect(
			isCurrentBranchProbe({ _: ["config"], currentBranch: true }),
		).toBe(false);
	});
});

const createBoundedWindowsResolver = () => {
	let terminalParentResolutions = 0;

	return {
		resolvePath: (...paths: string[]) => {
			const resolved = win32.resolve(...paths);
			const currentDir = paths[0];
			if (
				currentDir !== undefined &&
				paths.at(-1) === ".." &&
				resolved === currentDir
			) {
				terminalParentResolutions += 1;
				if (terminalParentResolutions > 1) {
					throw new Error(
						"Context walk did not stop at the filesystem root.",
					);
				}
			}
			return resolved;
		},
		terminalParentResolutions: () => terminalParentResolutions,
	};
};

describe("walkContextFile with Windows path semantics", () => {
	const root = win32.normalize("/");
	const home = "C:\\Users\\test-user";

	test("terminates after reaching a drive root from a nested directory", () => {
		const cwd = "C:\\workspace\\nested";
		const { resolvePath, terminalParentResolutions } =
			createBoundedWindowsResolver();

		expect(walkContextFile(cwd, root, home, resolvePath, () => false)).toBe(
			win32.resolve(cwd, ".neon"),
		);
		expect(terminalParentResolutions()).toBe(1);
	});

	test("terminates when invoked directly at a drive root", () => {
		const cwd = "D:\\";
		const { resolvePath, terminalParentResolutions } =
			createBoundedWindowsResolver();

		expect(walkContextFile(cwd, root, home, resolvePath, () => false)).toBe(
			win32.resolve(cwd, ".neon"),
		);
		expect(terminalParentResolutions()).toBe(1);
	});

	test("terminates after reaching a UNC share root", () => {
		const cwd = "\\\\server\\share\\workspace\\nested";
		const { resolvePath, terminalParentResolutions } =
			createBoundedWindowsResolver();

		expect(walkContextFile(cwd, root, home, resolvePath, () => false)).toBe(
			win32.resolve(cwd, ".neon"),
		);
		expect(terminalParentResolutions()).toBe(1);
	});

	test("uses a context file found before the root", () => {
		const cwd = "C:\\workspace\\nested";
		const contextFile = "C:\\workspace\\.neon";
		const { resolvePath, terminalParentResolutions } =
			createBoundedWindowsResolver();

		expect(
			walkContextFile(
				cwd,
				root,
				home,
				resolvePath,
				(file) => file === contextFile,
			),
		).toBe(contextFile);
		expect(terminalParentResolutions()).toBe(0);
	});

	test("does not inspect a context file in the home directory", () => {
		const cwd = "C:\\Users\\test-user\\workspace";
		const inspectedFiles: string[] = [];
		const { resolvePath, terminalParentResolutions } =
			createBoundedWindowsResolver();

		walkContextFile(cwd, root, home, resolvePath, (file) => {
			inspectedFiles.push(file);
			return false;
		});

		expect(inspectedFiles).toEqual([
			"C:\\Users\\test-user\\workspace\\.neon",
		]);
		expect(terminalParentResolutions()).toBe(0);
	});
});

describe("currentContextFile", () => {
	let workspace: string;

	beforeEach(() => {
		workspace = mkdtempSync(join(tmpdir(), "neonctl-ctx-"));
	});

	afterEach(() => {
		rmSync(workspace, { recursive: true, force: true });
	});

	test("defaults to <cwd>/.neon when no .neon exists anywhere upward", () => {
		const sub = join(workspace, "sub");
		mkdirSync(sub);
		expect(currentContextFile(sub)).toBe(join(sub, ".neon"));
	});

	test("walks up to an existing .neon in a parent directory", () => {
		writeFileSync(
			join(workspace, ".neon"),
			JSON.stringify({ projectId: "parent-project" }),
		);
		const sub = join(workspace, "nested", "deeper");
		mkdirSync(sub, { recursive: true });
		expect(currentContextFile(sub)).toBe(join(workspace, ".neon"));
	});

	test("does NOT walk up for unrelated project markers (package.json, .git)", () => {
		// Regression: previously `currentContextFile` treated `package.json` and
		// `.git` as project markers and walked up to them, which made
		// `neonctl link` from a fresh sub-directory inside an existing repo land
		// its `.neon` at the parent repo's root instead of the cwd.
		writeFileSync(join(workspace, "package.json"), "{}");
		mkdirSync(join(workspace, ".git"));
		const sub = join(workspace, "fresh-sub");
		mkdirSync(sub);
		expect(currentContextFile(sub)).toBe(join(sub, ".neon"));
	});
});

describe("ensureGitignored", () => {
	let workspace: string;

	beforeEach(() => {
		workspace = mkdtempSync(join(tmpdir(), "neonctl-gi-"));
	});

	afterEach(() => {
		rmSync(workspace, { recursive: true, force: true });
	});

	test("creates a .gitignore listing .neon when none exists", () => {
		const contextFile = join(workspace, ".neon");
		ensureGitignored(contextFile);
		const gitignore = readFileSync(join(workspace, ".gitignore"), "utf-8");
		expect(gitignore).toBe(".neon\n");
	});

	test("appends .neon to an existing .gitignore that does not have it", () => {
		const gi = join(workspace, ".gitignore");
		writeFileSync(gi, "node_modules\ndist\n");
		ensureGitignored(join(workspace, ".neon"));
		expect(readFileSync(gi, "utf-8")).toBe("node_modules\ndist\n.neon\n");
	});

	test("does not duplicate .neon when already present", () => {
		const gi = join(workspace, ".gitignore");
		writeFileSync(gi, "node_modules\n.neon\ndist\n");
		ensureGitignored(join(workspace, ".neon"));
		expect(readFileSync(gi, "utf-8")).toBe("node_modules\n.neon\ndist\n");
	});

	test("tolerates a .gitignore that has no trailing newline", () => {
		const gi = join(workspace, ".gitignore");
		writeFileSync(gi, "node_modules");
		ensureGitignored(join(workspace, ".neon"));
		expect(readFileSync(gi, "utf-8")).toBe("node_modules\n.neon\n");
	});

	test("treats surrounding whitespace as part of the line", () => {
		const gi = join(workspace, ".gitignore");
		// Trailing spaces around the entry should still count as a match.
		writeFileSync(gi, "  .neon  \n");
		ensureGitignored(join(workspace, ".neon"));
		expect(readFileSync(gi, "utf-8")).toBe("  .neon  \n");
	});

	test("skips the entry when a glob already covers it, as git would", () => {
		const gi = join(workspace, ".gitignore");
		// `git check-ignore` reports `.neon` as ignored by `*.neon` (the `*` matches the
		// empty string), so appending `.neon` would only add a redundant line.
		writeFileSync(gi, "*.neon\n");
		ensureGitignored(join(workspace, ".neon"));
		expect(readFileSync(gi, "utf-8")).toBe("*.neon\n");
	});

	test("does NOT treat a path-scoped entry like foo/.neon as covering", () => {
		const gi = join(workspace, ".gitignore");
		writeFileSync(gi, "foo/.neon\n");
		ensureGitignored(join(workspace, ".neon"));
		expect(readFileSync(gi, "utf-8")).toBe("foo/.neon\n.neon\n");
	});

	test("covers a created .env with an existing .env* / *.local glob", () => {
		const gi = join(workspace, ".gitignore");
		writeFileSync(gi, "node_modules\n.env*\n");
		ensureGitignored(join(workspace, ".env.local"));
		expect(readFileSync(gi, "utf-8")).toBe("node_modules\n.env*\n");

		writeFileSync(gi, "*.local\n");
		ensureGitignored(join(workspace, ".env.local"));
		expect(readFileSync(gi, "utf-8")).toBe("*.local\n");
	});

	test("adds a created .env when nothing in .gitignore covers it", () => {
		const gi = join(workspace, ".gitignore");
		writeFileSync(gi, "node_modules\n.env.production\n");
		ensureGitignored(join(workspace, ".env.local"));
		expect(readFileSync(gi, "utf-8")).toBe(
			"node_modules\n.env.production\n.env.local\n",
		);
	});

	test("ignores comments and negations when deciding coverage", () => {
		const gi = join(workspace, ".gitignore");
		// `!` re-includes rather than ignores, and a comment is not a pattern at all —
		// neither may suppress the entry we need.
		writeFileSync(gi, "# .env.local\n!.env.local\n");
		ensureGitignored(join(workspace, ".env.local"));
		expect(readFileSync(gi, "utf-8")).toBe(
			"# .env.local\n!.env.local\n.env.local\n",
		);
	});
});

describe("applyContext", () => {
	let workspace: string;

	beforeEach(() => {
		workspace = mkdtempSync(join(tmpdir(), "neonctl-apply-"));
	});

	afterEach(() => {
		rmSync(workspace, { recursive: true, force: true });
	});

	test("scaffolds .gitignore only when the context file is created", () => {
		const file = join(workspace, ".neon");
		applyContext(file, {
			orgId: "org-x",
			projectId: "proj-y",
			branchId: "br-z",
		});
		expect(JSON.parse(readFileSync(file, "utf-8"))).toEqual({
			orgId: "org-x",
			projectId: "proj-y",
			branchId: "br-z",
		});
		expect(readFileSync(join(workspace, ".gitignore"), "utf-8")).toBe(
			".neon\n",
		);
	});

	test("does NOT re-add .neon to .gitignore on updates to an existing file", () => {
		const file = join(workspace, ".neon");
		// First write creates the file and scaffolds .gitignore.
		applyContext(file, { projectId: "proj-y", branchId: "br-1" });
		// The user deliberately un-ignores .neon (e.g. to commit shared context).
		writeFileSync(join(workspace, ".gitignore"), "node_modules\n");

		// A subsequent update must NOT re-add the entry.
		applyContext(file, { projectId: "proj-y", branchId: "br-2" });

		expect(JSON.parse(readFileSync(file, "utf-8"))).toEqual({
			projectId: "proj-y",
			branchId: "br-2",
		});
		expect(readFileSync(join(workspace, ".gitignore"), "utf-8")).toBe(
			"node_modules\n",
		);
	});
});
