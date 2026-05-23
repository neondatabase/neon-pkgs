import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Build a transient project tree under the OS temp directory.
 *
 * Returns the absolute root path plus a `cleanup()` that removes the tree. Tests should
 * call `cleanup()` from an `afterEach`/`afterAll` hook.
 *
 * `files` is a flat map of relative paths → contents; intermediate directories are created
 * automatically. Directories themselves can be created by passing `null` as the value.
 *
 * A `.git/HEAD` marker is seeded at the root by default so the platform's upward walkers
 * (which stop at `.git`) don't escape the synthetic repo and read the developer's real
 * `~/.neon`. Pass an explicit `.git` entry in `files` to override or position it elsewhere
 * (e.g. for tests that exercise the boundary behaviour itself).
 */
export function makeTempRepo(files: Record<string, string | null>): {
	root: string;
	cleanup: () => void;
} {
	const root = mkdtempSync(join(tmpdir(), "neon-ts-test-"));
	const callerSpecifiesGit = Object.keys(files).some(
		(p) => p === ".git" || p.startsWith(".git/"),
	);
	const entries: Array<[string, string | null]> = callerSpecifiesGit
		? Object.entries(files)
		: [[".git/HEAD", "ref: refs/heads/main\n"], ...Object.entries(files)];
	for (const [relPath, contents] of entries) {
		const abs = join(root, relPath);
		mkdirSync(dirname(abs), { recursive: true });
		if (contents !== null) {
			writeFileSync(abs, contents, "utf-8");
		} else {
			mkdirSync(abs, { recursive: true });
		}
	}
	return {
		root,
		cleanup: () => {
			rmSync(root, { recursive: true, force: true });
		},
	};
}
