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
 *
 * `--from-branch` is the exception: it seeds the policy from a branch's live state, so it
 * needs both credentials and a resolved project. The raw argv is checked alongside the parsed
 * flag because this runs from middleware that executes before validation, where the parsed
 * value may not be populated yet (the same reason `analytics.ts` scans argv for
 * `--current-branch`).
 */
export const isConfigInit = (args: {
	_: (string | number)[];
	fromBranch?: boolean;
}): boolean =>
	args._[0] === "config" &&
	args._[1] === "init" &&
	args.fromBranch !== true &&
	!process.argv.includes("--from-branch");

/**
 * `neon profile …` manages credentials on disk and never calls the Neon API, so the global
 * auth middleware must skip it — mirroring {@link isConfigInit}.
 *
 * More than a nicety: without this, listing your profiles would launch a browser login, and
 * removing a broken profile would demand you sign into it first. Removing a profile whose
 * access has already lapsed is the main reason to remove one.
 */
export const isProfileCommand = (args: { _: (string | number)[] }): boolean =>
	args._[0] === "profile" || args._[0] === "profiles";

/**
 * `neon api-keys …`, under either spelling. Exempts the group from context enrichment: how
 * far a credential reaches must come from an explicit flag, never from `.neon`.
 */
export const isApiKeysCommand = (args: { _: (string | number)[] }): boolean =>
	args._[0] === "api-keys" || args._[0] === "api-key";

export const isMcpCommand = (args: { _: (string | number)[] }): boolean =>
	args._[0] === "mcp";

export const isSkillsCommand = (args: { _: (string | number)[] }): boolean =>
	args._[0] === "skills";

export const isPluginsCommand = (args: { _: (string | number)[] }): boolean =>
	args._[0] === "plugins";

/** Raw argv is required because auth middleware runs before MCP flags are parsed. */
export const isMcpOauth = (args: { _: (string | number)[] }): boolean =>
	isMcpCommand(args) && argvEnablesMcpOauth(process.argv);

const OAUTH_FALSE = new Set(["false", "0", "no"]);

function argvEnablesMcpOauth(argv: readonly string[]): boolean {
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--oauth=true" || arg === "--oauth=1") {
			return true;
		}
		if (arg === "--oauth=false" || arg === "--oauth=0") {
			continue;
		}
		if (arg === "--oauth") {
			const next = argv[i + 1];
			if (next !== undefined && OAUTH_FALSE.has(next.toLowerCase())) {
				continue;
			}
			return true;
		}
	}
	return false;
}

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
	// `api-keys` mints credentials, and how far a credential reaches must be something the
	// user typed — never something inherited from whichever project happens to be checked
	// out. Enriched here, `api-keys create --name ci` in a linked directory would quietly
	// produce a key scoped to that project instead of the account key it asked for.
	if (isApiKeysCommand(args)) {
		return;
	}
	// `profile create --mint` mints one too, and for the same reason must take its scope only
	// from what was typed: enriched here, running it inside a linked directory would quietly
	// produce a key scoped to that project rather than the account or organization asked for.
	// No `profile` subcommand has any use for a project or branch.
	if (isProfileCommand(args)) {
		return;
	}
	// MCP reads the linked project separately; enriching here would silently pin global installs.
	if (isMcpCommand(args)) {
		return;
	}
	if (isSkillsCommand(args) || isPluginsCommand(args)) {
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
 * Make sure the `.gitignore` next to `file` covers the file's basename — used for the `.neon`
 * context file and for a `.env` we create (both carry credentials that must not be committed).
 * Creates the `.gitignore` if it doesn't exist, otherwise appends the entry only when nothing
 * there already covers it: an exact line, or a basename glob such as `.env*` / `*.local`
 * (see {@link gitignoreCovers}), so a repo that already ignores env files doesn't collect a
 * redundant line per pull.
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
	return content
		.split(/\r?\n/)
		.some((line) => gitignoreCovers(line.trim(), entry));
};

/**
 * Whether a single `.gitignore` line already ignores `entry` (a bare basename like `.neon` or
 * `.env.local`).
 *
 * Deliberately narrow: an exact match, or a glob **without a path separator** — the
 * `.env*` / `*.local` / `.env.?` shapes that repos actually use for env files — matched
 * against the whole basename. Everything else returns false, which at worst appends an entry
 * git already covers (harmless) rather than skipping one it doesn't (a committed credential).
 * That's why path-scoped patterns (`config/.env`), negations (`!.env.local`), character
 * classes, and comments are all treated as "does not cover".
 */
const gitignoreCovers = (line: string, entry: string): boolean => {
	if (line === "" || line.startsWith("#") || line.startsWith("!")) {
		return false;
	}
	// A trailing slash marks a directory-only pattern; the leading one anchors to the
	// .gitignore's own directory, which is exactly where `entry` lives.
	const pattern = line.replace(/\/$/, "").replace(/^\//, "");
	if (pattern === entry) return true;
	if (pattern.includes("/") || pattern.includes("[")) return false;
	if (!pattern.includes("*") && !pattern.includes("?")) return false;
	return globToRegExp(pattern).test(entry);
};

/** Compile a separator-free `.gitignore` glob (`*` / `?` only) into an anchored RegExp. */
const globToRegExp = (pattern: string): RegExp => {
	const source = pattern
		.replace(/[.+^${}()|\\]/g, "\\$&")
		.replace(/\*/g, "[^/]*")
		.replace(/\?/g, "[^/]");
	return new RegExp(`^${source}$`);
};
