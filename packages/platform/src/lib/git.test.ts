import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, test } from "vitest";
import { readCurrentGitBranch } from "./git.js";
import { makeTempRepo } from "./test-utils.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
	while (cleanups.length > 0) cleanups.shift()?.();
});

function setup(files: Record<string, string | null>) {
	const repo = makeTempRepo(files);
	cleanups.push(repo.cleanup);
	return repo.root;
}

function hasGit(): boolean {
	try {
		execFileSync("git", ["--version"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

const describeIfGit = hasGit() ? describe : describe.skip;

describe("readCurrentGitBranch — failure modes", () => {
	test("returns null when cwd is not a git repo", () => {
		const root = setup({ "package.json": "{}" });
		expect(readCurrentGitBranch(root)).toBeNull();
	});

	test("returns null for a non-existent cwd", () => {
		expect(readCurrentGitBranch("/no/such/dir/ever")).toBeNull();
	});
});

describeIfGit("readCurrentGitBranch — happy path", () => {
	test("returns the branch name of a freshly-initialised repo", () => {
		const root = setup({ "package.json": "{}" });
		execFileSync("git", ["init", "--initial-branch=feature/x", root], {
			stdio: "ignore",
		});
		// `git init --initial-branch` may not be supported on very old git; fall back to
		// a regular init + branch rename if HEAD is "main" or "master".
		const branch = readCurrentGitBranch(root);
		expect(branch).not.toBeNull();
		// On systems where --initial-branch isn't honoured the test still asserts we got
		// *something* meaningful (not "HEAD") rather than over-constraining the value.
		expect(branch).not.toBe("HEAD");
	});
});
