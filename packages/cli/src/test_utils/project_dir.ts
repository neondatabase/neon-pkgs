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
 * The `.git` marker is what makes this deterministic: without it the lockfile
 * walk continues out of the temp directory into `$TMPDIR`'s ancestors, where
 * whatever lockfile it finds first decides the answer — so the same assertion
 * passes on one machine and fails on another.
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
