/**
 * Package manager detection and install helpers for the Neon CLI.
 *
 * Every command that shells out to install dependencies should go through here
 * rather than reading `npm_config_user_agent` or lockfiles on its own.
 *
 * - {@link detectProjectPackageManager} — lockfile walk from `cwd` up to the repo root
 * - {@link detectPackageManager} — the tool that launched this process (`npx`, `pnpm dlx`, …)
 * - {@link resolvePackageManager} — project lockfile, then invocation, then PATH, then npm
 *   (installing into an existing project directory)
 * - {@link resolveInvokingPackageManager} — invocation, then PATH, then npm (global installs,
 *   or when the target directory has no lockfile yet, e.g. a fresh scaffold)
 * - {@link formatInstallCommand} — shell-ready `pnpm install` / `npm add …` for agents and hints
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import which from "which";
import { log } from "../log.js";

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

// npm first so it's the default/preselected choice; the rest follow in rough
// popularity order.
export const PACKAGE_MANAGERS: PackageManager[] = [
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
/** Lockfiles in detection order (npm last — see comment on the array). */
export const LOCKFILES: ReadonlyArray<
	readonly [file: string, pm: PackageManager]
> = [
	["pnpm-lock.yaml", "pnpm"],
	["yarn.lock", "yarn"],
	// bun 1.2+ writes the text `bun.lock`; older versions the binary `bun.lockb`.
	["bun.lock", "bun"],
	["bun.lockb", "bun"],
	["package-lock.json", "npm"],
];

/**
 * The package manager the project at `cwd` uses, from its lockfile. Searches
 * `cwd` and then each parent up to the repo root: in a monorepo the lockfile
 * sits at the root while we scaffold into a package. Stopping at the root keeps
 * a stray lockfile above the repository from deciding how we install into it.
 */
export const detectProjectPackageManager = (
	cwd: string,
): PackageManager | undefined => {
	let dir = cwd;
	for (;;) {
		for (const [file, pm] of LOCKFILES) {
			if (existsSync(join(dir, file))) return pm;
		}
		// After the lockfiles, not before: the repo root's own lockfile counts.
		// `.git` is a file rather than a directory in a worktree or submodule.
		if (existsSync(join(dir, ".git"))) return undefined;
		const parent = dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
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
	detectProjectPackageManager(cwd) ??
	detectPackageManager() ??
	installedPackageManagers()[0] ??
	"npm";

/**
 * Pick a package manager when there is no project lockfile to read — global
 * installs, or scaffolding into a directory that does not exist yet. Same chain
 * as {@link resolvePackageManager} minus the lockfile walk.
 */
export const resolveInvokingPackageManager = (): PackageManager =>
	detectPackageManager() ?? installedPackageManagers()[0] ?? "npm";

/**
 * The argv that adds `packages` as runtime dependencies with `pm`. npm spells it
 * `install`; pnpm/yarn/bun use `add`.
 */
export const addDependenciesArgs = (
	pm: PackageManager,
	packages: string[],
): string[] => (pm === "npm" ? ["install", ...packages] : ["add", ...packages]);

/** argv to install every dependency from the project's manifest. */
export const installDependenciesArgs = (pm: PackageManager): string[] => [
	"install",
];

/**
 * A shell-ready install line for agents and "next steps" hints — e.g.
 * `pnpm add @neon/config @neon/env` or `npm install`.
 */
export const formatInstallCommand = (
	pm: PackageManager,
	packages?: string[],
): string => {
	const args = packages?.length
		? addDependenciesArgs(pm, packages)
		: installDependenciesArgs(pm);
	return `${pm} ${args.join(" ")}`;
};

/**
 * Text for agent instructions: which lockfiles to check and in what order.
 */
export const describeLockfileDetection = (): string =>
	`check for ${LOCKFILES.map(([file]) => file).join(", ")}, or default to npm`;

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
