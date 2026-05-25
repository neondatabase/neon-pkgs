import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

export const PLATFORM_PACKAGE_NAME = "@neondatabase/platform";

export interface PackageInstallTarget {
	/** Directory where the dependency should be added. */
	dir: string;
	packageManager: PackageManager;
}

export interface EnsurePlatformPackageResult {
	installed: boolean;
	skipped: boolean;
	packageRoot?: string;
	packageManager?: PackageManager;
	message: string;
}

export interface EnsurePlatformPackageOptions {
	cwd: string;
	stopAt?: string;
}

export type InstallCommandRunner = (
	command: string,
	args: string[],
	options: { cwd: string },
) => Promise<number>;

export interface EnsurePlatformPackageDeps {
	runInstall?: InstallCommandRunner;
}

const LOCKFILE_PACKAGE_MANAGERS: ReadonlyArray<[string, PackageManager]> = [
	["bun.lockb", "bun"],
	["bun.lock", "bun"],
	["pnpm-lock.yaml", "pnpm"],
	["yarn.lock", "yarn"],
	["package-lock.json", "npm"],
];

/**
 * Walk up from `cwd` to find where `@neondatabase/platform` should be installed.
 *
 * Prefers the nearest ancestor directory that contains a lockfile (workspace root in
 * monorepos). When no lockfile is found, falls back to the nearest `package.json`.
 */
export function findPackageInstallTarget(
	options: EnsurePlatformPackageOptions,
): PackageInstallTarget | null {
	const startDir = resolve(options.cwd);
	const stopAt = resolve(options.stopAt ?? homedir());
	let current = startDir;
	let nearestPackageJsonDir: string | null = null;

	while (true) {
		const lockfilePm = detectPackageManagerFromLockfiles(current);
		if (lockfilePm) {
			return { dir: current, packageManager: lockfilePm };
		}

		if (
			!nearestPackageJsonDir &&
			existsSync(join(current, "package.json"))
		) {
			nearestPackageJsonDir = current;
		}

		if (current === stopAt || hasGitMarker(current)) break;

		const parent = dirname(current);
		if (parent === current) break;
		current = parent;
	}

	if (!nearestPackageJsonDir) return null;

	return {
		dir: nearestPackageJsonDir,
		packageManager:
			detectPackageManagerFromPackageJson(nearestPackageJsonDir) ?? "npm",
	};
}

export function isPlatformPackageInstalled(packageRoot: string): boolean {
	const packageJsonPath = join(packageRoot, "package.json");
	if (!existsSync(packageJsonPath)) return false;

	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(packageJsonPath, "utf-8"));
	} catch {
		return false;
	}

	if (
		parsed === null ||
		typeof parsed !== "object" ||
		Array.isArray(parsed)
	) {
		return false;
	}

	return (
		hasDependency(readObjectField(parsed, "dependencies")) ||
		hasDependency(readObjectField(parsed, "devDependencies"))
	);
}

function hasDependency(section: unknown): boolean {
	if (
		section === null ||
		typeof section !== "object" ||
		Array.isArray(section)
	) {
		return false;
	}
	return PLATFORM_PACKAGE_NAME in section;
}

export function buildPlatformInstallCommand(packageManager: PackageManager): {
	command: string;
	args: string[];
} {
	switch (packageManager) {
		case "npm":
			return {
				command: "npm",
				args: [
					"install",
					PLATFORM_PACKAGE_NAME,
					"--no-fund",
					"--no-audit",
					"--loglevel=error",
				],
			};
		case "pnpm":
			return {
				command: "pnpm",
				args: ["add", PLATFORM_PACKAGE_NAME, "--loglevel=error"],
			};
		case "yarn":
			return {
				command: "yarn",
				args: ["add", PLATFORM_PACKAGE_NAME],
			};
		case "bun":
			return {
				command: "bun",
				args: ["add", PLATFORM_PACKAGE_NAME],
			};
	}
}

/**
 * Detect the package manager and install `@neondatabase/platform` when it is missing.
 * Returns a human-readable status message; throws nothing — callers decide whether a
 * failed install should abort `init`.
 */
export async function ensurePlatformPackageInstalled(
	options: EnsurePlatformPackageOptions,
	deps: EnsurePlatformPackageDeps = {},
): Promise<EnsurePlatformPackageResult> {
	const target = findPackageInstallTarget(options);
	if (!target) {
		return {
			installed: false,
			skipped: true,
			message: [
				"No package.json found while walking up from the current directory.",
				`Install ${PLATFORM_PACKAGE_NAME} manually before using neon.ts.`,
			].join(" "),
		};
	}

	if (isPlatformPackageInstalled(target.dir)) {
		return {
			installed: false,
			skipped: true,
			packageRoot: target.dir,
			packageManager: target.packageManager,
			message: `${PLATFORM_PACKAGE_NAME} is already listed in ${join(target.dir, "package.json")}.`,
		};
	}

	const { command, args } = buildPlatformInstallCommand(
		target.packageManager,
	);
	const runInstall = deps.runInstall ?? spawnAndWait;
	const exitCode = await runInstall(command, args, { cwd: target.dir });
	if (exitCode !== 0) {
		return {
			installed: false,
			skipped: false,
			packageRoot: target.dir,
			packageManager: target.packageManager,
			message: [
				`Failed to install ${PLATFORM_PACKAGE_NAME} with ${target.packageManager} (exit ${exitCode}).`,
				`Run \`${formatManualInstallHint(target.packageManager)}\` in ${target.dir} and retry.`,
			].join(" "),
		};
	}

	return {
		installed: true,
		skipped: false,
		packageRoot: target.dir,
		packageManager: target.packageManager,
		message: `Installed ${PLATFORM_PACKAGE_NAME} with ${target.packageManager} in ${target.dir}.`,
	};
}

export function formatManualInstallHint(
	packageManager: PackageManager,
): string {
	switch (packageManager) {
		case "npm":
			return `npm install ${PLATFORM_PACKAGE_NAME}`;
		case "pnpm":
			return `pnpm add ${PLATFORM_PACKAGE_NAME}`;
		case "yarn":
			return `yarn add ${PLATFORM_PACKAGE_NAME}`;
		case "bun":
			return `bun add ${PLATFORM_PACKAGE_NAME}`;
	}
}

function detectPackageManagerFromLockfiles(dir: string): PackageManager | null {
	for (const [filename, packageManager] of LOCKFILE_PACKAGE_MANAGERS) {
		if (existsSync(join(dir, filename))) return packageManager;
	}
	return null;
}

function detectPackageManagerFromPackageJson(
	dir: string,
): PackageManager | null {
	const packageJsonPath = join(dir, "package.json");
	if (!existsSync(packageJsonPath)) return null;

	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(packageJsonPath, "utf-8"));
	} catch {
		return null;
	}

	if (
		parsed === null ||
		typeof parsed !== "object" ||
		Array.isArray(parsed)
	) {
		return null;
	}

	const packageManager = readStringField(parsed, "packageManager");
	if (packageManager === null) return null;

	const [name] = packageManager.split("@");
	if (
		name === "npm" ||
		name === "pnpm" ||
		name === "yarn" ||
		name === "bun"
	) {
		return name;
	}
	return null;
}

function hasGitMarker(dir: string): boolean {
	return existsSync(join(dir, ".git"));
}

function readObjectField(obj: object, key: string): unknown {
	if (!Object.hasOwn(obj, key)) return undefined;
	return Reflect.get(obj, key);
}

function readStringField(obj: object, key: string): string | null {
	const value = readObjectField(obj, key);
	if (typeof value !== "string" || value === "") return null;
	return value;
}

function spawnAndWait(
	command: string,
	args: string[],
	options: { cwd: string },
): Promise<number> {
	return new Promise((resolveExitCode) => {
		const child = spawn(command, args, {
			cwd: options.cwd,
			stdio: "inherit",
		});
		child.on("error", () => {
			resolveExitCode(1);
		});
		child.on("exit", (code) => {
			resolveExitCode(typeof code === "number" ? code : 1);
		});
	});
}
