import { execa } from "execa";

/**
 * Returns the neonctl command prefix: "CI= npx -y neonctl".
 *
 * neonctl reads NEON_API_HOST and NEON_OAUTH_HOST from the environment
 * directly, so no extra flags are needed.
 *
 * Usage: `${neonctlCmd()} orgs list --output json`
 */
export function neonctlCmd(): string {
	return "CI= npx -y neonctl";
}

/**
 * Detects which package manager was used to invoke the current process.
 * Reads the `npm_config_user_agent` env var set by npm/pnpm/yarn/bun when
 * they spawn child processes (including via `npx`, `pnpx`, `bunx`, etc.).
 *
 * Falls back to "npm" if detection fails.
 */
export function detectPackageManager(): "npm" | "pnpm" | "yarn" | "bun" {
	const ua = process.env.npm_config_user_agent;
	if (ua) {
		if (ua.startsWith("pnpm/")) return "pnpm";
		if (ua.startsWith("yarn/")) return "yarn";
		if (ua.startsWith("bun/")) return "bun";
	}
	return "npm";
}

/**
 * Returns the global install command for a given package manager.
 */
function globalInstallArgs(
	pm: "npm" | "pnpm" | "yarn" | "bun",
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

interface NeonctlStatus {
	installed: boolean;
	currentVersion: string | null;
	latestVersion: string | null;
	needsUpdate: boolean;
}

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

export interface EnsureNeonctlResult {
	status: "already_current" | "installed" | "updated" | "failed";
	version?: string;
	error?: string;
}

/**
 * Ensures neonctl is globally installed and up to date.
 * Uses the same package manager that invoked the init command.
 */
export async function ensureNeonctl(): Promise<EnsureNeonctlResult> {
	const check = await checkNeonctl();

	if (check.installed && !check.needsUpdate) {
		return {
			status: "already_current",
			version: check.currentVersion ?? undefined,
		};
	}

	const pm = detectPackageManager();
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
