import { accessSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, normalize, resolve } from "node:path";
import type yargs from "yargs";

import { log } from "./log.js";

export type Context = {
	orgId?: string;
	projectId?: string;
	/**
	 * The pinned branch, stored as its **name** when known (nicer to read in
	 * `.neon`) or its id otherwise. Resolved to an id by the usual name-or-id
	 * resolution wherever a branch id is needed.
	 */
	branch?: string;
	/**
	 * Legacy field. Still read via {@link contextBranch} so older `.neon` files
	 * keep working, but new writes use {@link Context.branch}; the legacy field is
	 * dropped the next time the context is written.
	 */
	branchId?: string;
};

/**
 * The branch pinned in a context, reading the current `branch` field and
 * falling back to the legacy `branchId` so pre-migration `.neon` files keep
 * working.
 */
export const contextBranch = (context: Context): string | undefined =>
	context.branch ?? context.branchId;

/**
 * True when the invocation is the offline "current branch" probe:
 * `(config) status --current-branch`. This mode only reads the pinned branch
 * from the local `.neon` file (for shell prompts like starship), so it MUST
 * NOT touch the network — several middlewares (auth, analytics, single-project
 * resolution) consult this to early-return and skip their API calls / login.
 *
 * Gated on the exact command as well as the flag so an accidental
 * `--current-branch` on an unrelated command (e.g. `config plan`, where the flag
 * is undefined but non-strict yargs still parses it) can't silently skip
 * auth/analytics. The probe is only `status` (the top-level alias) or
 * `config status` (`_ = ['config', 'status']`).
 */
export const isCurrentBranchProbe = (args: {
	_: (string | number)[];
	currentBranch?: boolean;
}): boolean =>
	args.currentBranch === true &&
	(args._[0] === "status" ||
		(args._[0] === "config" && args._[1] === "status"));

/**
 * `config init` only scaffolds a local `neon.ts` and installs npm packages — it
 * never calls the Neon API. Gated on the exact command path so the global auth
 * middleware and the single-project resolver can skip it (it runs with no API
 * client), mirroring {@link isCurrentBranchProbe}.
 */
export const isConfigInit = (args: { _: (string | number)[] }): boolean =>
	args._[0] === "config" && args._[1] === "init";

const CONTEXT_FILE = ".neon";
const GITIGNORE_FILE = ".gitignore";

type ResolvePath = (...paths: string[]) => string;
type CanAccessFile = (file: string) => boolean;

const canAccessFile = (file: string): boolean => {
	try {
		accessSync(file);
		return true;
	} catch {
		return false;
	}
};

/**
 * Walk upward to find an existing `.neon` file.
 *
 * The walk keeps the established home and POSIX-root boundaries, then also
 * stops when resolving a parent makes no progress. That second guard handles
 * Windows drive and UNC-share roots, whose paths do not equal `normalize("/")`.
 */
export const walkContextFile = (
	cwd: string,
	root: string,
	home: string,
	resolvePath: ResolvePath,
	canAccess: CanAccessFile,
): string => {
	let currentDir = cwd;
	while (currentDir !== root && currentDir !== home) {
		const contextFile = resolvePath(currentDir, CONTEXT_FILE);
		if (canAccess(contextFile)) {
			return contextFile;
		}

		const parentDir = resolvePath(currentDir, "..");
		if (parentDir === currentDir) {
			break;
		}
		currentDir = parentDir;
	}

	return resolvePath(cwd, CONTEXT_FILE);
};

/**
 * Resolve the default `.neon` path for the current working directory.
 *
 * Walks UP from `cwd` looking ONLY for an already-existing `.neon` file so
 * commands run from a sub-directory of a linked project still pick up the
 * project's context. If no `.neon` is found, the path defaults to
 * `<cwd>/.neon`, which makes `neonctl link` and `neonctl set-context`
 * predictable: they always write the context file into the directory they
 * were invoked from.
 *
 * Historically the walk also considered `package.json` and `.git` as project
 * markers, but that led to surprising behaviour when running `link` from a
 * fresh sub-directory inside an unrelated repo (the new link would land in
 * the parent repo's root instead of the cwd).
 *
 * `cwd` is overridable so tests can exercise the walk-up without mutating
 * `process.cwd()` (which would race with other tests running in parallel).
 */
export const currentContextFile = (cwd: string = process.cwd()) =>
	walkContextFile(cwd, normalize("/"), homedir(), resolve, canAccessFile);

export const readContextFile = (file: string): Context => {
	try {
		return JSON.parse(readFileSync(file, "utf-8"));
	} catch {
		return {};
	}
};

export const enrichFromContext = (
	args: yargs.Arguments<{ contextFile: string }>,
) => {
	// `link` and the deprecated `set-context` manage the context file themselves
	// and must see the raw flags rather than values pre-filled from an existing
	// `.neon`, so skip enrichment for both.
	if (args._[0] === "link" || args._[0] === "set-context") {
		return;
	}
	const context = readContextFile(args.contextFile);
	if (!args.orgId) {
		args.orgId = context.orgId;
	}
	if (!args.projectId) {
		args.projectId = context.projectId;
	}
	if (
		!args.branch &&
		!args.id &&
		!args.name &&
		context.projectId === args.projectId
	) {
		args.branch = contextBranch(context);
	}
};

export const updateContextFile = (file: string, context: Context) => {
	writeFileSync(file, JSON.stringify(context, null, 2));
};

/**
 * Shared primitive used by `link`, the deprecated `set-context`, and `checkout`
 * to persist context. Mirrors the destructive write semantics of
 * `updateContextFile` — any field not present in `context` is dropped from the
 * file.
 *
 * `.gitignore` scaffolding only happens when the context file is being
 * *created* (it didn't exist before this write). On updates to an existing
 * `.neon` we never touch `.gitignore`, so a user who deliberately un-ignored
 * the file (e.g. to commit shared context) won't have the entry re-added on
 * every subsequent command.
 */
export const applyContext = (file: string, context: Context) => {
	const isNewFile = !existsSync(file);
	updateContextFile(file, context);
	if (isNewFile) {
		ensureGitignored(file);
	}
};

/**
 * A fully-resolved project context: the org and project are always known, the
 * branch optionally so (pin one later with `neonctl checkout`).
 */
export type ResolvedContext = {
	orgId: string;
	projectId: string;
	/** Branch name (preferred) or id. Optional. */
	branch?: string;
};

/**
 * Low-level writer for callers that already hold the resolved identifiers and
 * just need to record them — e.g. `init` or `projects create`, which create a
 * project and want to link it without the resolution, verification, prompting,
 * or env-pull that `link` performs.
 *
 * Unlike the loose {@link applyContext}, this enforces at the type level that
 * `orgId` and `projectId` are present, so the `.neon` file never ends up with a
 * dangling project that has no org. The branch stays optional. It writes through
 * {@link applyContext}, so the same `.gitignore` scaffolding applies.
 */
export const setContext = (file: string, context: ResolvedContext) => {
	applyContext(file, {
		orgId: context.orgId,
		projectId: context.projectId,
		branch: context.branch,
	});
};

/**
 * Make sure the `.gitignore` next to `file` lists the file's basename
 * (currently always `.neon`). Creates the `.gitignore` if it doesn't exist,
 * or appends `.neon` if it's missing — never duplicates an existing entry.
 *
 * Best-effort: a failure here (e.g. read-only filesystem) is logged at debug
 * level and swallowed; persisting the context file is the primary goal and
 * must not be blocked by a `.gitignore` write error.
 */
export const ensureGitignored = (file: string): void => {
	try {
		const dir = dirname(file);
		const entry = basenameOf(file);
		const gitignorePath = resolve(dir, GITIGNORE_FILE);

		if (!existsSync(gitignorePath)) {
			writeFileSync(gitignorePath, `${entry}\n`);
			return;
		}

		const current = readFileSync(gitignorePath, "utf-8");
		if (hasGitignoreEntry(current, entry)) {
			return;
		}

		const needsLeadingNewline =
			current.length > 0 && !current.endsWith("\n");
		const addition = `${needsLeadingNewline ? "\n" : ""}${entry}\n`;
		writeFileSync(gitignorePath, current + addition);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		log.debug("Failed to update .gitignore next to %s: %s", file, message);
	}
};

const basenameOf = (file: string): string => {
	const parts = file.split(/[\\/]/);
	return parts[parts.length - 1] || CONTEXT_FILE;
};

const hasGitignoreEntry = (content: string, entry: string): boolean => {
	return content.split(/\r?\n/).some((line) => line.trim() === entry);
};
