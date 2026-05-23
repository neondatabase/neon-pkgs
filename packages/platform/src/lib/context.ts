import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import { MissingContextError } from "./errors.js";

/**
 * Resolved Neon project context. `projectId` is required; `orgId` is optional because
 * single-tenant Neon accounts and personal projects do not have one. `branchId` is read
 * from the same file when present so that branch-aware tools can use it.
 */
export interface ProjectContext {
	projectId: string;
	orgId?: string;
	/** Neon branch id (`br-…`) stored in the context file, if any. */
	branchId?: string;
	/** Absolute path of the file the context was read from. */
	sourcePath: string;
}

export interface ContextLoaderOptions {
	/** Starting directory for the upward walk. Defaults to `process.cwd()`. */
	cwd?: string;
	/** Stop directory for the upward walk. Defaults to the OS home directory. */
	stopAt?: string;
}

/**
 * Walk up from `cwd` looking for a project-context file. Returns the first one found.
 *
 * Preference order at each directory:
 * 1. `<dir>/.neon/project.json` (this package's preferred convention)
 * 2. `<dir>/.neon` (neonctl's existing convention — a JSON file, not a directory)
 *
 * The walk picks the **closest** context file as we ascend. It is deliberately
 * monorepo-friendly: intermediate `package.json` files do **not** stop the walk, so a
 * `.neon` lifted to the workspace root keeps working when invoked from inside any
 * sub-package. The walk terminates at the first directory that contains `.git` (the repo
 * root), or at `stopAt` (default: home directory), or at the filesystem root — whichever
 * comes first.
 *
 * Returns `null` when no context file is found. This function does **no** writes — per the
 * package's read-only-filesystem contract, callers that want to bootstrap a context file
 * should do so themselves (e.g. via `neonctl set-context`).
 */
export function findProjectContext(
	options: ContextLoaderOptions = {},
): ProjectContext | null {
	const startDir = resolve(options.cwd ?? process.cwd());
	const stopAt = resolve(options.stopAt ?? homedir());

	let current = startDir;
	let lastSeen: string | null = null;

	while (true) {
		const result = readContextAt(current);
		if (result) return result;

		if (current === stopAt) return null;
		if (hasGitMarker(current)) return null;

		const parent = dirname(current);
		if (parent === current || parent === lastSeen) return null;
		lastSeen = current;
		current = parent;
	}
}

/**
 * Same as {@link findProjectContext} but throws {@link MissingContextError} when no context
 * file is found. Used by `pullConfig` (which requires a context to know which project to
 * pull) and by `pushConfig` when no explicit `projectId` is supplied.
 */
export function requireProjectContext(
	options: ContextLoaderOptions = {},
): ProjectContext {
	const ctx = findProjectContext(options);
	if (ctx) return ctx;
	const startDir = resolve(options.cwd ?? process.cwd());
	const stopDir = resolve(options.stopAt ?? homedir());
	throw new MissingContextError(
		[
			`No Neon project context file found while walking up from ${startDir} to ${stopDir}.`,
			"Looked for `.neon/project.json` (preferred) and `.neon` (neonctl convention) in every directory along the way (stopping at the first `.git`).",
			"To fix, either:",
			"  - Create one with `npx neonctl set-context --project-id <id>` (writes a `.neon` file at the project root), or",
			'  - Write `.neon/project.json` yourself with `{ "projectId": "…", "orgId": "…" }`, or',
			"  - Pass `projectId` (and optionally `orgId`) directly to the SDK / CLI, or set `NEON_PROJECT_ID` in `process.env`.",
		].join("\n"),
	);
}

function readContextAt(dir: string): ProjectContext | null {
	const dirPath = resolve(dir, ".neon", "project.json");
	if (existsFile(dirPath)) {
		const parsed = parseContextFile(dirPath);
		if (parsed) return parsed;
	}

	const filePath = resolve(dir, ".neon");
	if (existsFile(filePath)) {
		const parsed = parseContextFile(filePath);
		if (parsed) return parsed;
	}

	return null;
}

function parseContextFile(path: string): ProjectContext | null {
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
	const projectId = obj.projectId;
	if (typeof projectId !== "string" || projectId === "") return null;
	const orgIdRaw = obj.orgId;
	const branchIdRaw = obj.branchId;
	const ctx: ProjectContext = { projectId, sourcePath: path };
	if (typeof orgIdRaw === "string" && orgIdRaw !== "") ctx.orgId = orgIdRaw;
	if (typeof branchIdRaw === "string" && branchIdRaw !== "")
		ctx.branchId = branchIdRaw;
	return ctx;
}

function hasGitMarker(dir: string): boolean {
	return existsPath(resolve(dir, ".git"));
}

function existsFile(path: string): boolean {
	if (!isAbsolute(path)) return false;
	try {
		const s = statSync(path);
		return s.isFile();
	} catch {
		return (
			existsSync(path) &&
			(() => {
				try {
					return statSync(path).isFile();
				} catch {
					return false;
				}
			})()
		);
	}
}

function existsPath(path: string): boolean {
	try {
		return existsSync(path);
	} catch {
		return false;
	}
}
