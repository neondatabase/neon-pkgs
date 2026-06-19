import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { vi } from "vitest";

/**
 * Every Neon env var (and adjacent OS env var) the platform package reads at runtime.
 * Used by {@link stubCleanNeonEnv} to give each test a deterministic, empty starting
 * env regardless of the developer's local `~/.config/neonctl`, exported `NEON_*` vars,
 * or anything else carried over from the parent shell.
 */
const NEON_AND_RELATED_ENV_KEYS = [
	"NEON_API_KEY",
	"NEON_PROJECT_ID",
	"NEON_BRANCH_ID",
	"NEON_ORG_ID",
	"NEON_AUTH_BASE_URL",
	"NEON_AUTH_JWKS_URL",
	"NEON_DATA_API_URL",
	"AWS_ACCESS_KEY_ID",
	"AWS_SECRET_ACCESS_KEY",
	"AWS_ENDPOINT_URL_S3",
	"AWS_REGION",
	"OPENAI_API_KEY",
	"OPENAI_BASE_URL",
	"DATABASE_URL",
	"DATABASE_URL_UNPOOLED",
	"NEONCTL_CONFIG_DIR",
	"HOME",
	"USERPROFILE",
] as const;

/**
 * Stub every Neon-related env var to `undefined` (so they look unset to the code under
 * test). Tests can override individual keys with `vi.stubEnv(key, value)` after calling
 * this. `vitest.config.ts` sets `unstubEnvs: true` so each test's stubs are auto-reset.
 *
 * Call this from a `beforeEach` in any test file that touches `process.env`-driven
 * resolution (api key / context / connection-string env vars).
 */
export function stubCleanNeonEnv(): void {
	for (const key of NEON_AND_RELATED_ENV_KEYS) {
		// vitest 3.x: passing `undefined` deletes the env var (rather than setting it
		// to the literal string "undefined") — exactly what we want, because empty
		// strings would still trip code that reads `env.HOME` to build paths.
		vi.stubEnv(key, undefined);
	}
}

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
