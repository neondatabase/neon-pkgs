import {
	credentialInputs,
	selectCredential,
} from "@neon-internals/cli-core/auth_selection";
import { configDir } from "@neon-internals/cli-core/paths";
import { DEFAULT_PROFILE } from "@neon-internals/cli-core/profiles";

/**
 * API-key selections fall back to DEFAULT because init authenticates from stored credentials.
 */
export function selectedProfileName(): string {
	const selection = selectCredential(credentialInputs());
	return selection.source === "profile" ? selection.profile : DEFAULT_PROFILE;
}

/**
 * `--config-dir` is on argv, not in the environment. `configDir()` without it reads
 * `NEON_CONFIG_DIR` or the home path, so a named profile that exists only in the
 * flagged directory would be reported as unknown.
 */
export function selectedConfigDir(): string {
	const recorded = credentialInputs().configDir;
	return recorded !== "" ? recorded : configDir();
}

/**
 * Implicit DEFAULT is omitted to preserve existing command strings. Explicit DEFAULT remains
 * because an ambient `NEON_PROFILE` would otherwise override it in subprocesses.
 */
export function explicitProfileArgs(): string[] {
	const selection = selectCredential(credentialInputs());
	if (selection.source === "profile" && selection.explicit) {
		return ["--profile", selection.profile];
	}
	return [];
}

export function explicitProfileCli(): string {
	const args = explicitProfileArgs();
	return args.length === 0 ? "" : ` ${args.join(" ")}`;
}

export function npxNeonArgs(command: string[]): string[] {
	return ["-y", "neon", ...explicitProfileArgs(), ...command];
}

export function neonInitAgentCmd(data: Record<string, unknown>): string {
	return `neon init --agent${explicitProfileCli()} --data '${JSON.stringify(data)}'`;
}
