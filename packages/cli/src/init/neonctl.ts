import { lstatSync } from "node:fs";
import { execa } from "execa";
import {
	globalInstallCommand,
	resolveInvokingPackageManager,
} from "../utils/package_manager.js";
import { neonBin } from "./neon_bin.js";
import { explicitConfigDirCli, explicitProfileCli } from "./profile_cli.js";

/**
 * Emits the installed `neon` binary when it's on PATH, else `npx -y neon` (see
 * {@link neonBin}) — so the command works before `neon init` has installed the CLI
 * and uses the installed binary afterwards. `CI=` keeps emitted calls
 * non-interactive. API and OAuth hosts stay ambient because the CLI reads them directly.
 */
export function neonctlCmd(): string {
	return `CI= ${neonBin()}${explicitProfileCli()}${explicitConfigDirCli()}`;
}

type NeonctlStatus = {
	installed: boolean;
	currentVersion: string | null;
	latestVersion: string | null;
	needsUpdate: boolean;
};

/**
 * The global binaries that indicate the Neon CLI is installed. The current
 * package ships `neon`; `neonctl` is the legacy alias, kept in the probe so an
 * older global install still counts as "installed" (and isn't reinstalled).
 */
const NEON_CLI_BINARIES = ["neon", "neonctl"] as const;

/**
 * Gets the currently installed Neon CLI version, probing the `neon` binary
 * first and falling back to the legacy `neonctl` alias. Returns null when the
 * CLI isn't on PATH.
 */
async function getNeonCliVersion(): Promise<string | null> {
	for (const bin of NEON_CLI_BINARIES) {
		try {
			const result = await execa(bin, ["--version"], {
				stdio: "pipe",
				timeout: 5000,
			});
			const match = result.stdout.trim().match(/(\d+\.\d+\.\d+)/);
			if (match) return match[1];
		} catch {
			// This binary isn't installed — try the next one.
		}
	}
	return null;
}

/**
 * Checks whether the Neon CLI is globally installed and whether it's up to date.
 */
export async function checkNeonctl(): Promise<NeonctlStatus> {
	const currentVersion = await getNeonCliVersion();

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
		const result = await execa("npm", ["view", "neon", "version"], {
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
	action?: "installing" | "updating";
};

/**
 * Checks if neonctl is installed via a local dev symlink.
 * If so, skip install/update — the developer manages it manually.
 */
function isLocalDevSymlink(): boolean {
	try {
		const home = process.env.HOME || process.env.USERPROFILE || "";
		const nvmDir = process.env.NVM_DIR || `${home}/.nvm`;
		// Check common global module locations for a symlink, under both the
		// current `neon` package name and the legacy `neonctl` one.
		const roots = [
			`${nvmDir}/versions/node/${process.version}/lib/node_modules`,
			`${home}/.nvm/versions/node/${process.version}/lib/node_modules`,
		];
		for (const root of roots) {
			for (const pkg of NEON_CLI_BINARIES) {
				try {
					const stat = lstatSync(`${root}/${pkg}`);
					if (stat.isSymbolicLink()) return true;
				} catch {
					// path doesn't exist
				}
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
export async function ensureNeonctl(
	onProgress?: (phase: "installing" | "updating") => void,
): Promise<EnsureNeonctlResult> {
	// Skip install for local dev symlinks to avoid permission errors
	if (isLocalDevSymlink()) {
		const version = await getNeonCliVersion();
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
	const install = globalInstallCommand(pm, "neon");
	const action = check.installed ? "updating" : "installing";
	if (!install) {
		// The next step is installing a package manager, not falling back to
		// npx: npx ships with npm, so it is missing in exactly this case.
		return {
			status: "failed",
			action,
			error:
				`Could not ${action === "updating" ? "update" : "install"} the Neon CLI: this machine has no package manager that can perform a global install. ` +
				"npm, pnpm and bun are not on PATH (yarn Berry has no global install). " +
				"Install npm, pnpm or bun, then run this again.",
		};
	}
	const { command, args } = install;
	onProgress?.(action);

	try {
		await execa(command, args, { stdio: "pipe", timeout: 60000 });

		// Verify installation
		const version = await getNeonCliVersion();
		return {
			status: check.installed ? "updated" : "installed",
			version: version ?? undefined,
		};
	} catch (err) {
		return {
			status: "failed",
			action,
			error: err instanceof Error ? err.message : "Unknown error",
		};
	}
}
