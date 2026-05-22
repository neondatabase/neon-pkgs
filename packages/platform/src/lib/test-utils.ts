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
 */
export function makeTempRepo(files: Record<string, string | null>): {
	root: string;
	cleanup: () => void;
} {
	const root = mkdtempSync(join(tmpdir(), "neon-platform-test-"));
	for (const [relPath, contents] of Object.entries(files)) {
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
