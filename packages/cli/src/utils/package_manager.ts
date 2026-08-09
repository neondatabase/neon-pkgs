/**
 * Package manager detection and install helpers for the Neon CLI.
 *
 * Every command that shells out to install dependencies should go through here
 * rather than reading `npm_config_user_agent` or lockfiles on its own.
 *
 * **`detect*` may return undefined, `resolve*` never does**, and `inferPackageManager` is the
 * composed detector for callers that can prompt rather than guess.
 *
 * - {@link detectProjectPackageManager} — lockfile walk from `cwd` up to the repo root
 * - {@link detectInvokingPackageManager} — the tool that launched us (`npx`, `pnpm dlx`, …)
 * - {@link inferPackageManager} — project, then invocation, or nothing (when there is
 *   something to ask the user, an unanswerable guess is worse than a prompt)
 * - {@link resolvePackageManager} — project lockfile, then invocation, then PATH, then npm
 *   (installing into an existing project directory)
 * - {@link resolveInvokingPackageManager} — invocation, then PATH, then npm (global installs,
 *   or when the target directory has no lockfile yet, e.g. a fresh scaffold)
 * - {@link installArgs} — argv to install into a project; {@link globalInstallCommand} —
 *   command and argv to install a CLI globally, or undefined when nothing here can
 * - {@link formatInstallCommand} — shell-ready `pnpm install` / `npm add …` for agents and hints
 * - {@link formatExecCommand} — shell-ready `pnpm exec drizzle-kit …` for a binary the project
 *   already depends on, plus {@link MISSING_BINARY_HINT} for the step that carries it
 *
 * Never re-derive any of this at a call site: a second detector is a second answer, and the
 * two disagree exactly where it hurts — an agent told to run `npm install` in a pnpm project.
 * That includes spelling an install command by hand. Every install string the CLI prints,
 * emits as agent JSON, or hands to {@link runCommand} comes from the formatters here.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
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
 * The physical path, so the walk climbs real parents.
 *
 * `dirname` is lexical: given a symlink to `repo/packages/app`, its parent is
 * the symlink's directory, not `repo/packages` — so the walk would leave the
 * repository immediately and never see the root lockfile.
 *
 * A path that doesn't exist yet is fine and keeps its lexical form: `bootstrap`
 * resolves a target directory before creating it. Anything else — a permission
 * error, a symlink loop, a path component that is not a directory — is a broken
 * input rather than a missing one, and silently falling back to the lexical path
 * would pick a package manager off the wrong tree.
 */
const physicalPath = (dir: string): string => {
	try {
		return realpathSync(dir);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return dir;
		throw new Error(
			`Could not resolve ${dir} while detecting the package manager: ${
				err instanceof Error ? err.message : String(err)
			}`,
		);
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
	const start = physicalPath(cwd);
	const root = repoRoot(start);
	if (root === undefined) return lockfileIn(start);

	let dir = start;
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
export const detectInvokingPackageManager = (): PackageManager | undefined => {
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
	detectProjectPackageManager(cwd) ?? detectInvokingPackageManager();

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
	detectInvokingPackageManager() ?? installedPackageManagers()[0] ?? "npm";

/** Where an added package lands in `package.json`. */
export type AddOptions = { dev?: boolean };

/**
 * The argv for an install with `pm`: every dependency in the manifest when
 * `packages` is empty, otherwise those packages added to it. npm spells the add
 * verb `install`; pnpm/yarn/bun use `add`. All four spell the whole-manifest
 * install `install`.
 *
 * The one argv builder — pass its result to {@link runCommand}, or use
 * {@link formatInstallCommand} for a string. Nothing else assembles these words.
 */
export const installArgs = (
	pm: PackageManager,
	packages?: string[],
	options?: AddOptions,
): string[] =>
	packages?.length
		? [
				pm === "npm" ? "install" : "add",
				// All four accept -D for devDependencies, bun included.
				...(options?.dev ? ["-D"] : []),
				...packages,
			]
		: ["install"];

/**
 * yarn's major version, or undefined when it can't be read. Only consulted on
 * the global-install path, which already spawns.
 */
const yarnMajor = (): number | undefined => {
	const result = spawnSync("yarn", ["--version"], {
		encoding: "utf8",
		timeout: 5000,
		// yarn ships as a .cmd shim on Windows, which needs a shell.
		shell: process.platform === "win32",
	});
	const major = result.stdout?.trim().match(/^(\d+)\./);
	return major ? Number(major[1]) : undefined;
};

/** The managers that can install a global CLI at all — yarn Berry cannot. */
const GLOBAL_CAPABLE: readonly PackageManager[] = ["npm", "pnpm", "bun"];

/**
 * The argv that installs `pkg` globally — a standalone CLI, not a project
 * dependency — or undefined when this machine has no way to do it.
 *
 * Yarn Berry removed global installs with no replacement, so `yarn global add`
 * works on Classic only and Berry answers "Unknown command". Berry falls back to
 * whichever global-capable manager is actually on PATH, which is normally npm.
 *
 * Substituting a manager is safe *here* and nowhere else in this module: a
 * global install has no project dependency tree to be wrong about, which is the
 * whole reason the project's manager must win for {@link installArgs}. What is
 * not safe is naming a command that cannot run — npm ships with Node but is
 * packaged separately on some Linux distributions, so returning `npm install -g`
 * unchecked would hand a Berry user a command their machine does not have. The
 * caller decides what to say when there is nothing to return.
 */
export const globalInstallCommand = (
	pm: PackageManager,
	pkg: string,
): { command: string; args: string[] } | undefined => {
	// Running `yarn --version` at all proves yarn is on PATH.
	if (pm === "yarn" && yarnMajor() === 1)
		return { command: "yarn", args: ["global", "add", pkg] };

	// Every branch checks PATH, not just the yarn fallback: `pm` can be the
	// `?? "npm"` default from resolveInvokingPackageManager, which is a guess
	// about a machine nobody has looked at yet.
	const installed = installedPackageManagers();
	const usable =
		pm !== "yarn" && installed.includes(pm)
			? pm
			: installed.find((candidate) => GLOBAL_CAPABLE.includes(candidate));
	if (!usable) return undefined;

	return usable === "npm"
		? { command: "npm", args: ["install", "-g", pkg] }
		: { command: usable, args: ["add", "-g", pkg] };
};

/**
 * A shell-ready line that runs `binary` out of the project's own
 * `node_modules/.bin`.
 *
 * Every form here is local-only, which is the point: bare `npx` and `bunx` fall
 * back to downloading a package that isn't installed, so a skipped install step
 * would migrate someone's database with an unpinned tool fetched mid-run instead
 * of failing. `npx --no` refuses with "canceled due to missing packages", and
 * `bun run` with "Script not found".
 *
 * `pnpm exec` and `yarn run` are already local-only — `dlx` is the fetching
 * counterpart in both. Use those deliberately, not these, to run something the
 * project does not depend on.
 *
 * `yarn run` over `yarn exec`, which is documented for Berry but not Classic.
 * Like `bun run`, it prefers a package.json script of the same name, so a script
 * called `prisma` would shadow the binary.
 */
export const formatExecCommand = (
	pm: PackageManager,
	binary: string,
	args: string[] = [],
): string => {
	const runner = {
		npm: "npx --no",
		pnpm: "pnpm exec",
		yarn: "yarn run",
		bun: "bun run",
	}[pm];
	return [runner, binary, ...args].join(" ");
};

/**
 * Belongs in the description of any agent step whose command came from
 * {@link formatExecCommand}.
 *
 * npm's own refusal reads "npx canceled due to missing packages and no YES
 * option", which hands the reader the exact flag that defeats the protection —
 * and the same payload contains `npx -y` elsewhere, so `-y` looks like the house
 * style. Without this, an agent that hits the guard plausibly retries with `-y`
 * and runs an unpinned migration tool against the user's database.
 */
export const MISSING_BINARY_HINT =
	"If this fails saying the package is missing, the install step above did not complete — run that step, then retry this one. Do not add -y, and do not switch to npx, pnpm dlx, yarn dlx or bunx: those download an unpinned copy of the tool and run it against the user's database.";

/**
 * Belongs in the description of any agent step whose command came from
 * {@link formatInstallCommand}. The command already names the project's package
 * manager, and an agent normalising it to npm is the bug this module exists to
 * prevent.
 */
export const DO_NOT_SUBSTITUTE_HINT =
	"Run this step's `command` exactly as written — it already uses this project's package manager. Do not rewrite it to npm or any other manager.";

/**
 * A shell-ready install line for agents and "next steps" hints — e.g.
 * `pnpm add @neon/config @neon/env`, or `pnpm install` with no packages.
 * All four managers spell the whole-manifest install `install`.
 */
export const formatInstallCommand = (
	pm: PackageManager,
	packages?: string[],
	options?: AddOptions,
): string => `${pm} ${installArgs(pm, packages, options).join(" ")}`;

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
