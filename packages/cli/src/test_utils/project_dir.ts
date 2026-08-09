import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PackageManager } from "../utils/package_manager.js";

/** The lockfile each package manager is recognised by. */
const LOCKFILE: Record<PackageManager, string> = {
	npm: "package-lock.json",
	pnpm: "pnpm-lock.yaml",
	yarn: "yarn.lock",
	bun: "bun.lock",
};

/**
 * A throwaway project directory that `resolvePackageManager` will read as `pm`.
 *
 * The `.git` marker models a repository root, which is what a real project has
 * and what the lockfile walk uses as its boundary. Tests that need the
 * no-repository case should build the directory themselves rather than reach for
 * this.
 */
export const makeProjectDir = (
	pm: PackageManager,
): { dir: string; cleanup: () => void } => {
	const dir = mkdtempSync(join(tmpdir(), "neon-project-"));
	mkdirSync(join(dir, ".git"));
	writeFileSync(join(dir, LOCKFILE[pm]), "");
	return {
		dir,
		cleanup: () => rmSync(dir, { recursive: true, force: true }),
	};
};
