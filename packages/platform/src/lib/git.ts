import { execFileSync } from "node:child_process";

const GIT_TIMEOUT_MS = 1_000;

/**
 * Look up the current git branch name for the working tree at `cwd`.
 *
 * Returns the branch name (e.g. `"andrelandgraf/new-feature"`) on success, or `null` when
 * any of the following is true:
 * - `git` is not installed or not on PATH.
 * - `cwd` is not inside a git working tree.
 * - HEAD is detached (`git symbolic-ref --short HEAD` exits non-zero).
 * - Any unexpected failure (timeout, permission error, …).
 *
 * We deliberately use `symbolic-ref` rather than `rev-parse --abbrev-ref HEAD` because
 * the latter fails on freshly-initialised repos with no commits — exactly the case
 * `branch` is most useful in (a developer just bootstrapped a feature branch).
 *
 * Never throws — the function is intended to drive an *optional* enrichment of generated
 * branch names; failure simply means "no git context available, fall back to a bare
 * mini-id".
 */
export function readCurrentGitBranch(cwd: string): string | null {
	const branch = runGit(["symbolic-ref", "--short", "HEAD"], cwd);
	if (branch === null) return null;
	const trimmed = branch.trim();
	if (trimmed === "" || trimmed === "HEAD") return null;
	return trimmed;
}

function runGit(args: string[], cwd: string): string | null {
	try {
		return execFileSync("git", args, {
			cwd,
			stdio: ["ignore", "pipe", "ignore"],
			encoding: "utf-8",
			timeout: GIT_TIMEOUT_MS,
		});
	} catch {
		return null;
	}
}
