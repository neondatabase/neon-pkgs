/**
 * Package manager detection and install helpers for the Neon CLI.
 *
 * Every command that shells out to install dependencies should go through here
 * rather than reading `npm_config_user_agent` or lockfiles on its own.
 *
 * - {@link detectProjectPackageManager} — lockfile walk from `cwd` up to the repo root
 * - {@link detectPackageManager} — the tool that launched this process (`npx`, `pnpm dlx`, …)
 * - {@link inferPackageManager} — project, then invocation, or nothing (when there is
 *   something to ask the user, an unanswerable guess is worse than a prompt)
 * - {@link resolvePackageManager} — project lockfile, then invocation, then PATH, then npm
 *   (installing into an existing project directory)
 * - {@link resolveInvokingPackageManager} — invocation, then PATH, then npm (global installs,
 *   or when the target directory has no lockfile yet, e.g. a fresh scaffold)
 * - {@link addDependenciesArgs} / {@link globalInstallArgs} — argv to install into a project
 *   or globally
 * - {@link formatInstallCommand} — shell-ready `pnpm install` / `npm add …` for agents and hints
 *
 * Never re-derive any of this at a call site: a second detector is a second answer, and the
 * two disagree exactly where it hurts — an agent told to run `npm install` in a pnpm project.
 * That includes spelling an install command by hand. Every install string the CLI prints,
 * emits as agent JSON, or hands to {@link runCommand} comes from the formatters here.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import which from "which";
import { log } from "../log.js";

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

// npm first so it's the default/preselected choice; the rest follow in rough
// popularity order.
const PACKAGE_MANAGERS: readonly PackageManager[] = [
	"npm",
	"pnpm",
	"yarn",
	"bun",
];

/**
 * Lockfiles, and the package manager each one belongs to. npm is last on
 * purpose: a repo with both a pnpm lockfile and a leftover `package-lock.json`
 * (which a failed run like the one this fixes can leave behind) is a pnpm repo.
 */
const LOCKFILES: ReadonlyArray<readonly [file: string, pm: PackageManager]> = [
	["pnpm-lock.yaml", "pnpm"],
	["yarn.lock", "yarn"],
	// bun 1.2+ writes the text `bun.lock`; older versions the binary `bun.lockb`.
	["bun.lock", "bun"],
	["bun.lockb", "bun"],
	["package-lock.json", "npm"],
	["npm-shrinkwrap.json", "npm"],
];

const lockfileIn = (dir: string): PackageManager | undefined => {
	for (const [file, pm] of LOCKFILES) {
		if (existsSync(join(dir, file))) return pm;
	}
	return undefined;
};

/** `.git` is a file rather than a directory in a worktree or a submodule. */
const isRepoRoot = (dir: string): boolean => existsSync(join(dir, ".git"));

/**
 * The repository `dir` belongs to, or undefined when it belongs to none.
 */
const repoRoot = (dir: string): string | undefined => {
	let current = dir;
	for (;;) {
		if (isRepoRoot(current)) return current;
		const parent = dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
};

/**
 * The package manager the project at `cwd` uses, from its lockfile.
 *
 * The repository is the search boundary, and it is located *first*. Inside one,
 * the walk climbs from `cwd` to the repo root, because in a monorepo the
 * lockfile sits at the root while we install into a package. Outside any
 * repository — a directory `bootstrap` is about to scaffold into, which has no
 * `.git` until a later step — only `cwd` itself is read.
 *
 * Locating the boundary first is what makes that second case safe. Climbing and
 * checking as it went, a fresh scaffold under `~` would inherit a stray
 * `~/package-lock.json` and install with npm on the strength of a lockfile
 * belonging to nothing.
 */
export const detectProjectPackageManager = (
	cwd: string,
): PackageManager | undefined => {
	const root = repoRoot(cwd);
	if (root === undefined) return lockfileIn(cwd);

	let dir = cwd;
	for (;;) {
		const found = lockfileIn(dir);
		if (found) return found;
		if (dir === root) return undefined;
		dir = dirname(dir);
	}
};

/**
 * The package manager the CLI was invoked through, read from the
 * `npm_config_user_agent` npm sets for `npm exec`/`npx`, `pnpm dlx`, `yarn
 * dlx`, and `bunx` (so `pnpm dlx neonctl …` installs with pnpm). Returns
 * undefined when there's nothing to infer from — e.g. a globally-installed
 * `neon`/`neonctl` — so the caller can ask (or fall back) instead of silently
 * assuming npm.
 */
export const detectPackageManager = (): PackageManager | undefined => {
	const ua = process.env.npm_config_user_agent ?? "";
	if (ua.startsWith("pnpm")) return "pnpm";
	if (ua.startsWith("yarn")) return "yarn";
	if (ua.startsWith("bun")) return "bun";
	if (ua.startsWith("npm")) return "npm";
	return undefined;
};

/** The package managers actually on PATH, in {@link PACKAGE_MANAGERS} order. */
export const installedPackageManagers = (): PackageManager[] =>
	PACKAGE_MANAGERS.filter((pm) => which.sync(pm, { nothrow: true }) !== null);

/**
 * What can actually be inferred about the project at `cwd`: its lockfile, else
 * the tool the CLI was invoked through, else nothing.
 *
 * Returns undefined rather than guessing, so an interactive caller can prompt.
 * {@link resolvePackageManager} is the same chain with the unaskable fallbacks
 * appended — use this one only where there is a user to ask.
 */
export const inferPackageManager = (cwd: string): PackageManager | undefined =>
	detectProjectPackageManager(cwd) ?? detectPackageManager();

/**
 * Pick a package manager without prompting: the one the project at `cwd` uses,
 * else the one the CLI was invoked through, else the first one installed, else
 * npm. Used by non-interactive flows (e.g. `config init`) where there's no
 * scaffold prompt to hang a picker off.
 *
 * The project wins over the invocation on purpose. `npx neon …` inside a pnpm
 * repo should still install with pnpm — which tool launched us says nothing
 * about which one owns that project's `node_modules`, and running npm against
 * pnpm's symlinked tree is what this ordering exists to prevent.
 */
export const resolvePackageManager = (cwd: string): PackageManager =>
	inferPackageManager(cwd) ?? installedPackageManagers()[0] ?? "npm";

/**
 * Pick a package manager when there is no project lockfile to read — global
 * installs, or scaffolding into a directory that does not exist yet. Same chain
 * as {@link resolvePackageManager} minus the lockfile walk.
 */
export const resolveInvokingPackageManager = (): PackageManager =>
	detectPackageManager() ?? installedPackageManagers()[0] ?? "npm";

/** Where an added package lands in `package.json`. */
export type AddOptions = { dev?: boolean };

/** bun spells the devDependencies flag `-d`; the rest accept `-D`. */
const devFlag = (pm: PackageManager): string => (pm === "bun" ? "-d" : "-D");

/**
 * The argv that adds `packages` to the project's manifest with `pm`. npm spells
 * the verb `install`; pnpm/yarn/bun use `add`.
 */
export const addDependenciesArgs = (
	pm: PackageManager,
	packages: string[],
	options?: AddOptions,
): string[] => [
	pm === "npm" ? "install" : "add",
	...(options?.dev ? [devFlag(pm)] : []),
	...packages,
];

/**
 * The argv that installs `pkg` globally. yarn is the odd one out: `yarn global
 * add` rather than a flag on `add`.
 *
 * `yarn global add` is Yarn Classic only — Berry removed global installs and has
 * no replacement, so it answers with "Unknown command". Deliberately not
 * substituted with npm: silently installing through a different manager than the
 * user's is how this module's bug class started. Both callers surface the yarn
 * error and fall back to running the tool through `npx`, which is what a Berry
 * user would do by hand anyway.
 */
export const globalInstallArgs = (
	pm: PackageManager,
	pkg: string,
): { command: string; args: string[] } => {
	switch (pm) {
		case "pnpm":
			return { command: "pnpm", args: ["add", "-g", pkg] };
		case "yarn":
			return { command: "yarn", args: ["global", "add", pkg] };
		case "bun":
			return { command: "bun", args: ["add", "-g", pkg] };
		case "npm":
			return { command: "npm", args: ["install", "-g", pkg] };
	}
};

/**
 * A shell-ready install line for agents and "next steps" hints — e.g.
 * `pnpm add @neon/config @neon/env`, or `pnpm install` with no packages.
 * All four managers spell the whole-manifest install `install`.
 */
export const formatInstallCommand = (
	pm: PackageManager,
	packages?: string[],
	options?: AddOptions,
): string => {
	const args = packages?.length
		? addDependenciesArgs(pm, packages, options)
		: ["install"];
	return `${pm} ${args.join(" ")}`;
};

/**
 * Run a command inheriting our stdio so the user sees install / link output
 * live and can answer any prompts the child raises. Resolves to whether it
 * exited cleanly; a non-zero exit is reported but never throws — the caller
 * decides whether to treat it as fatal.
 */
export const runCommand = (
	cmd: string,
	args: string[],
	cwd: string,
	/**
	 * Extra environment for the child. Anything secret belongs here rather than in `args`:
	 * arguments are visible to any process that can list processes, and both handlers below
	 * print the full argument list when the command fails.
	 */
	env?: NodeJS.ProcessEnv,
): Promise<boolean> =>
	new Promise((resolvePromise) => {
		// npm/pnpm/yarn ship as .cmd shims on Windows, which need a shell to run.
		const child = spawn(cmd, args, {
			cwd,
			stdio: "inherit",
			shell: process.platform === "win32",
			...(env ? { env: { ...process.env, ...env } } : {}),
		});
		child.on("error", (err) => {
			log.warning(
				"Could not run `%s %s`: %s",
				cmd,
				args.join(" "),
				err instanceof Error ? err.message : String(err),
			);
			resolvePromise(false);
		});
		child.on("close", (code) => {
			if (code !== 0) {
				log.warning(
					"`%s %s` exited with code %d.",
					cmd,
					args.join(" "),
					code,
				);
			}
			resolvePromise(code === 0);
		});
	});
