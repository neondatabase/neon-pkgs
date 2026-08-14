import { lstatSync, realpathSync } from "node:fs";
import { sep } from "node:path";
import { execa } from "execa";
import which from "which";
import {
	globalInstallCommand,
	resolveInvokingPackageManager,
} from "../utils/package_manager.js";
import { neonBin } from "./neon_bin.js";

/**
 * Returns the Neon CLI command prefix the flow emits to agents/users, e.g.
 * `"CI= neon"` or `"CI= npx -y neon"` (see {@link neonBin} for how the `neon`
 * vs `npx -y neon` choice is made).
 *
 * The `CI=` prefix keeps the emitted subcommands (`orgs list`, `auth`, …)
 * non-interactive. The CLI reads NEON_API_HOST and NEON_OAUTH_HOST from the
 * environment directly, so no extra flags are needed.
 *
 * Usage: `${neonctlCmd()} orgs list --output json`
 */
export function neonctlCmd(): string {
	return `CI= ${neonBin()}`;
}

type NeonctlStatus = {
	installed: boolean;
	currentVersion: string | null;
	latestVersion: string | null;
	needsUpdate: boolean;
};

/**
 * Gets the currently installed `neon` CLI version, or null if it isn't on PATH.
 */
async function getNeonctlVersion(): Promise<string | null> {
	// Try global binary first (fast path)
	try {
		const result = await execa("neon", ["--version"], {
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
 * Checks whether the neon CLI is globally installed and whether it's up to date.
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
};

/**
 * Checks if the neon CLI is installed via a local dev symlink.
 * If so, skip install/update — the developer manages it manually.
 */
function isLocalDevSymlink(): boolean {
	try {
		const home = process.env.HOME || process.env.USERPROFILE || "";
		const nvmDir = process.env.NVM_DIR || `${home}/.nvm`;
		// `pnpm link` / `npm link` create a package symlink under global node_modules.
		const candidates = [
			`${nvmDir}/versions/node/${process.version}/lib/node_modules/neon`,
			`${home}/.nvm/versions/node/${process.version}/lib/node_modules/neon`,
		];
		for (const candidate of candidates) {
			try {
				const stat = lstatSync(candidate);
				if (stat.isSymbolicLink()) return true;
			} catch {
				// path doesn't exist
			}
		}

		// A bare bin symlink (e.g. `ln -s <repo>/dist/cli.js <bin>/neon`) points the
		// `neon` binary straight at a working tree. A real global install is also a
		// bin symlink, but one that resolves into a `node_modules` directory — so a
		// `neon` symlink resolving anywhere else is a developer's own build. Gated on
		// the bin being a symlink so a plain-file `neon` (a real install elsewhere, or
		// a test stub) is left to the normal install/update path.
		const bin = which.sync("neon", { nothrow: true });
		if (bin) {
			try {
				if (
					lstatSync(bin).isSymbolicLink() &&
					!realpathSync(bin).includes(`${sep}node_modules${sep}`)
				) {
					return true;
				}
			} catch {
				// unreadable — fall through
			}
		}
		return false;
	} catch {
		return false;
	}
}

/**
 * Ensures the `neon` CLI is globally installed and up to date.
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
	const install = globalInstallCommand(pm, "neon");
	if (!install) {
		// The next step is installing a package manager, not falling back to
		// npx: npx ships with npm, so it is missing in exactly this case.
		return {
			status: "failed",
			error:
				"Could not install the Neon CLI: this machine has no package manager that can perform a global install. " +
				"npm, pnpm and bun are not on PATH (yarn Berry has no global install). " +
				"Install npm, pnpm or bun, then run this again.",
		};
	}
	const { command, args } = install;

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
