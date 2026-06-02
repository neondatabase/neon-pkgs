import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

/**
 * Resolved project + branch context for the `neon-env` CLI. The CLI owns this resolution
 * (flags → `NEON_*` env → `.neon[/project.json]` file) so the `@neondatabase/env` library
 * functions can stay filesystem- and env-agnostic.
 */
export interface ResolvedContext {
	projectId: string;
	branchId: string;
	/** Branch name for `parseEnv`-style policy evaluation, when known. */
	branchName?: string;
}

export interface ResolveContextOptions {
	projectId?: string;
	branch?: string;
	cwd: string;
	env?: NodeJS.ProcessEnv;
}

/**
 * Resolve `projectId` and `branch` for a CLI invocation. Precedence (each wins over the
 * next): explicit flag → `NEON_*` env var → `.neon[/project.json]` walked up from `cwd`.
 *
 * Returns the resolved values plus a list of human-readable reasons for any field that
 * could not be resolved (so the caller can render one combined error).
 */
export function resolveContext(
	options: ResolveContextOptions,
): { ok: true; context: ResolvedContext } | { ok: false; missing: string[] } {
	const env = options.env ?? process.env;
	const file = findNeonFile(options.cwd);

	const projectId =
		nonEmpty(options.projectId) ??
		nonEmpty(env.NEON_PROJECT_ID) ??
		file?.projectId;

	const branchId =
		nonEmpty(options.branch) ??
		nonEmpty(env.NEON_BRANCH_ID) ??
		file?.branchId;

	const branchName = nonEmpty(env.NEON_BRANCH_NAME) ?? file?.branchName;

	const missing: string[] = [];
	if (!projectId) {
		missing.push(
			"project id — pass `--project-id`, set `NEON_PROJECT_ID`, or add `projectId` to `.neon/project.json` (run `npx neonctl link`).",
		);
	}
	if (!branchId) {
		missing.push(
			"branch — pass `--branch`, set `NEON_BRANCH_ID`, or add `branchId` to `.neon/project.json` (run `npx neonctl checkout <branch>`).",
		);
	}
	if (!projectId || !branchId) return { ok: false, missing };

	return {
		ok: true,
		context: {
			projectId,
			branchId,
			...(branchName ? { branchName } : {}),
		},
	};
}

interface NeonFile {
	projectId?: string;
	branchId?: string;
	branchName?: string;
}

/**
 * Walk up from `cwd` looking for `.neon/project.json` (preferred) or `.neon` (neonctl
 * convention). Stops at the first `.git` directory or the home directory. Read-only.
 */
function findNeonFile(cwd: string): NeonFile | null {
	let current = resolve(cwd);
	const stop = resolve(homedir());
	let lastSeen: string | null = null;

	while (true) {
		const parsed =
			readNeonFileAt(resolve(current, ".neon", "project.json")) ??
			readNeonFileAt(resolve(current, ".neon"));
		if (parsed) return parsed;

		if (current === stop) return null;
		if (existsSync(resolve(current, ".git"))) return null;

		const parent = dirname(current);
		if (parent === current || parent === lastSeen) return null;
		lastSeen = current;
		current = parent;
	}
}

function readNeonFileAt(path: string): NeonFile | null {
	if (!isFile(path)) return null;
	let raw: string;
	try {
		raw = readFileSync(path, "utf-8");
	} catch {
		return null;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
		return null;
	const obj = parsed as Record<string, unknown>;
	const out: NeonFile = {};
	if (typeof obj.projectId === "string" && obj.projectId !== "")
		out.projectId = obj.projectId;
	if (typeof obj.branchId === "string" && obj.branchId !== "")
		out.branchId = obj.branchId;
	if (typeof obj.branchName === "string" && obj.branchName !== "")
		out.branchName = obj.branchName;
	return out;
}

function isFile(path: string): boolean {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

function nonEmpty(value: string | undefined): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed === "" ? undefined : trimmed;
}
