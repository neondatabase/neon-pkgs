import { spawn } from "node:child_process";
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
 * Pick a package manager without prompting: the one the CLI was invoked through,
 * else the first one installed, else npm. Used by non-interactive flows (e.g.
 * `config init`) where there's no scaffold prompt to hang a picker off.
 */
export const resolvePackageManager = (): PackageManager =>
	detectPackageManager() ?? installedPackageManagers()[0] ?? "npm";

/**
 * The argv that adds `packages` as runtime dependencies with `pm`. npm spells it
 * `install`; pnpm/yarn/bun use `add`.
 */
export const addDependenciesArgs = (
	pm: PackageManager,
	packages: string[],
): string[] => (pm === "npm" ? ["install", ...packages] : ["add", ...packages]);

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
): Promise<boolean> =>
	new Promise((resolvePromise) => {
		// npm/pnpm/yarn ship as .cmd shims on Windows, which need a shell to run.
		const child = spawn(cmd, args, {
			cwd,
			stdio: "inherit",
			shell: process.platform === "win32",
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
