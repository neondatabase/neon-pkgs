import { lstatSync } from "node:fs";
import { execa } from "execa";
import {
	type PackageManager,
	resolveInvokingPackageManager,
} from "../utils/package_manager.js";

/**
 * Returns the Neon CLI command prefix: "CI= npx -y neon".
 *
 * The CLI reads NEON_API_HOST and NEON_OAUTH_HOST from the environment
 * directly, so no extra flags are needed. The `neon` package ships both the
 * `neon` and `neonctl` binaries; we surface the cleaner `neon` command in the
 * examples emitted to users and agents.
 *
 * Usage: `${neonctlCmd()} orgs list --output json`
 */
export function neonctlCmd(): string {
	return "CI= npx -y neon";
}

/**
 * Returns the global install command for a given package manager.
 */
function globalInstallArgs(
	pm: PackageManager,
	pkg: string,
): { command: string; args: string[] } {
	switch (pm) {
		case "pnpm":
			return { command: "pnpm", args: ["add", "-g", pkg] };
		case "yarn":
			return { command: "yarn", args: ["global", "add", pkg] };
		case "bun":
			return { command: "bun", args: ["add", "-g", pkg] };
		default:
			return { command: "npm", args: ["install", "-g", pkg] };
	}
}

type NeonctlStatus = {
	installed: boolean;
	currentVersion: string | null;
	latestVersion: string | null;
	needsUpdate: boolean;
};

/**
 * Gets the currently available neonctl version.
 * Tries the global binary first, then falls back to npx.
 */
async function getNeonctlVersion(): Promise<string | null> {
	// Try global binary first (fast path)
	try {
		const result = await execa("neonctl", ["--version"], {
			stdio: "pipe",
			timeout: 5000,
		});
		const match = result.stdout.trim().match(/(\d+\.\d+\.\d+)/);
		if (match) return match[1];
	} catch {
		// Not globally installed — that's fine
	}
	return null;
}

/**
 * Checks whether the neonctl CLI is globally installed and whether it's up to date.
 */
export async function checkNeonctl(): Promise<NeonctlStatus> {
	const currentVersion = await getNeonctlVersion();

	if (!currentVersion) {
		return {
			installed: false,
			currentVersion: null,
			latestVersion: null,
			needsUpdate: true,
		};
	}

	// Check latest version from npm registry
	let latestVersion: string | null = null;
	try {
		const result = await execa("npm", ["view", "neonctl", "version"], {
			stdio: "pipe",
			timeout: 10000,
		});
		latestVersion = result.stdout.trim();
	} catch {
		// Can't determine latest — assume current is fine
		return {
			installed: true,
			currentVersion,
			latestVersion: null,
			needsUpdate: false,
		};
	}

	const needsUpdate =
		currentVersion !== null &&
		latestVersion !== null &&
		currentVersion !== latestVersion &&
		isOlderVersion(currentVersion, latestVersion);

	return { installed: true, currentVersion, latestVersion, needsUpdate };
}

function isOlderVersion(current: string, latest: string): boolean {
	const c = current.split(".").map(Number);
	const l = latest.split(".").map(Number);
	for (let i = 0; i < 3; i++) {
		if ((c[i] ?? 0) < (l[i] ?? 0)) return true;
		if ((c[i] ?? 0) > (l[i] ?? 0)) return false;
	}
	return false;
}

export type EnsureNeonctlResult = {
	status: "already_current" | "installed" | "updated" | "failed";
	version?: string;
	error?: string;
};

/**
 * Checks if neonctl is installed via a local dev symlink.
 * If so, skip install/update — the developer manages it manually.
 */
function isLocalDevSymlink(): boolean {
	try {
		const home = process.env.HOME || process.env.USERPROFILE || "";
		const nvmDir = process.env.NVM_DIR || `${home}/.nvm`;
		// Check common global module locations for a symlink
		const candidates = [
			`${nvmDir}/versions/node/${process.version}/lib/node_modules/neonctl`,
			`${home}/.nvm/versions/node/${process.version}/lib/node_modules/neonctl`,
		];
		for (const candidate of candidates) {
			try {
				const stat = lstatSync(candidate);
				if (stat.isSymbolicLink()) return true;
			} catch {
				// path doesn't exist
			}
		}
		return false;
	} catch {
		return false;
	}
}

/**
 * Ensures neonctl is globally installed and up to date.
 * Uses the same package manager that invoked the init command.
 */
export async function ensureNeonctl(): Promise<EnsureNeonctlResult> {
	// Skip install for local dev symlinks to avoid permission errors
	if (isLocalDevSymlink()) {
		const version = await getNeonctlVersion();
		return {
			status: "already_current",
			version: version ?? "dev",
		};
	}

	const check = await checkNeonctl();

	if (check.installed && !check.needsUpdate) {
		return {
			status: "already_current",
			version: check.currentVersion ?? undefined,
		};
	}

	const pm = resolveInvokingPackageManager();
	const { command, args } = globalInstallArgs(pm, "neonctl");

	try {
		await execa(command, args, { stdio: "pipe", timeout: 60000 });

		// Verify installation
		const version = await getNeonctlVersion();
		return {
			status: check.installed ? "updated" : "installed",
			version: version ?? undefined,
		};
	} catch (err) {
		return {
			status: "failed",
			error: err instanceof Error ? err.message : "Unknown error",
		};
	}
}
