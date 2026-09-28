import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
	buildCheckoutEvent,
	currentGitBranch,
	GIT_HOOK_ENV_FLAG,
	gitPull,
	hasUpstream,
	installPostCheckoutHook,
	isGitRepo,
	isManagedHook,
	localGitBranches,
	postCheckoutHookPath,
	readGitContext,
	removePostCheckoutHook,
} from "./git.js";

const run = (args: string[], cwd: string) =>
	execFileSync("git", args, { cwd, stdio: "ignore" });

const initRepo = (dir: string) => {
	run(["init", "-b", "main"], dir);
	run(["config", "user.email", "test@example.com"], dir);
	run(["config", "user.name", "Test"], dir);
	// Pin a repo-local hooks dir so the suite is hermetic even when the machine has a global
	// `core.hooksPath` (e.g. a managed githooks directory) that would otherwise be targeted.
	run(["config", "core.hooksPath", ".git/hooks"], dir);
	writeFileSync(join(dir, "README.md"), "# test\n");
	run(["add", "."], dir);
	run(["commit", "-m", "init"], dir);
};

describe("git facts", () => {
	let repo: string;

	beforeEach(() => {
		repo = mkdtempSync(join(tmpdir(), "neon-git-"));
	});

	afterEach(() => {
		rmSync(repo, { recursive: true, force: true });
	});

	test("reports available:false outside a git repo", () => {
		const ctx = readGitContext(repo);
		expect(ctx.available).toBe(false);
		expect(ctx.branch).toBeUndefined();
	});

	test("reads the current branch, sha, and clean/dirty state", () => {
		initRepo(repo);
		expect(isGitRepo(repo)).toBe(true);
		expect(currentGitBranch(repo)).toBe("main");

		const clean = readGitContext(repo);
		expect(clean.available).toBe(true);
		expect(clean.branch).toBe("main");
		expect(clean.neonSafeBranchName).toBe("main");
		expect(clean.sha).toMatch(/^[0-9a-f]{40}$/);
		expect(clean.shortSha).toBeDefined();
		expect(clean.isDirty).toBe(false);
		expect(clean.isDetached).toBe(false);

		writeFileSync(join(repo, "new.txt"), "x");
		expect(readGitContext(repo).isDirty).toBe(true);
	});

	test('buildCheckoutEvent: "neon-checkout" outside the git hook, carrying inputName', () => {
		delete process.env.NEON_GIT_HOOK;
		initRepo(repo);
		const git = readGitContext(repo);
		expect(buildCheckoutEvent(git, "feature/billing")).toEqual({
			type: "neon-checkout",
			inputName: "feature/billing",
		});
		expect(buildCheckoutEvent(git, undefined)).toEqual({
			type: "neon-checkout",
			inputName: undefined,
		});
	});

	test('buildCheckoutEvent: "git-checkout" when the env flag is set, carrying gitBranch (never inputName)', () => {
		initRepo(repo);
		const git = readGitContext(repo);
		process.env[GIT_HOOK_ENV_FLAG] = "1";
		try {
			expect(buildCheckoutEvent(git, "ignored-typed-name")).toEqual({
				type: "git-checkout",
				gitBranch: "main",
			});
		} finally {
			delete process.env.NEON_GIT_HOOK;
		}
	});

	test("detects detached HEAD as isDetached with no branch", () => {
		initRepo(repo);
		const sha = execFileSync("git", ["rev-parse", "HEAD"], {
			cwd: repo,
			encoding: "utf-8",
		}).trim();
		run(["checkout", sha], repo);
		const ctx = readGitContext(repo);
		expect(ctx.isDetached).toBe(true);
		expect(ctx.branch).toBeUndefined();
		expect(ctx.neonSafeBranchName).toBeUndefined();
	});

	test("lists local branches", () => {
		initRepo(repo);
		run(["branch", "feature/x"], repo);
		expect(localGitBranches(repo).sort()).toEqual(["feature/x", "main"]);
	});

	test("hasUpstream is false with no remote configured", () => {
		initRepo(repo);
		expect(hasUpstream(repo)).toBe(false);
	});

	test("gitPull returns no-upstream when there's nothing to pull from", () => {
		initRepo(repo);
		expect(gitPull(repo)).toEqual({ status: "no-upstream" });
	});
});

describe("post-checkout hook management", () => {
	let repo: string;

	beforeEach(() => {
		repo = mkdtempSync(join(tmpdir(), "neon-git-hook-"));
		initRepo(repo);
	});

	afterEach(() => {
		rmSync(repo, { recursive: true, force: true });
	});

	test("installs a managed hook, then reports it as managed", () => {
		const hookPath = postCheckoutHookPath(repo);
		expect(existsSync(hookPath)).toBe(false);

		const result = installPostCheckoutHook(repo);
		expect(result).toEqual({ status: "installed" });
		expect(existsSync(hookPath)).toBe(true);
		expect(isManagedHook(hookPath)).toBe(true);
	});

	test("re-installing an existing managed hook reports updated", () => {
		installPostCheckoutHook(repo);
		const result = installPostCheckoutHook(repo);
		expect(result).toEqual({ status: "updated" });
	});

	test("refuses to overwrite a foreign hook", () => {
		const hookPath = postCheckoutHookPath(repo);
		writeFileSync(hookPath, "#!/usr/bin/env sh\necho foreign\n");
		const result = installPostCheckoutHook(repo);
		expect(result.status).toBe("conflict");
		expect(readFileSync(hookPath, "utf-8")).toContain("foreign");
	});

	test("removes a managed hook", () => {
		installPostCheckoutHook(repo);
		const hookPath = postCheckoutHookPath(repo);
		expect(removePostCheckoutHook(repo)).toBe("removed");
		expect(existsSync(hookPath)).toBe(false);
	});

	test("removing an absent hook reports absent", () => {
		expect(removePostCheckoutHook(repo)).toBe("absent");
	});

	test("removing a foreign hook leaves it in place and reports foreign", () => {
		const hookPath = postCheckoutHookPath(repo);
		writeFileSync(hookPath, "#!/usr/bin/env sh\necho foreign\n");
		expect(removePostCheckoutHook(repo)).toBe("foreign");
		expect(existsSync(hookPath)).toBe(true);
	});
});
