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
 * An explicit `--config-dir` must override `NEON_CONFIG_DIR` and the home path.
 */
export function selectedConfigDir(): string {
	const recorded = credentialInputs().configDir;
	return recorded !== "" ? recorded : configDir();
}

/**
 * Omitting implicit DEFAULT preserves command compatibility; retaining explicit DEFAULT
 * prevents ambient `NEON_PROFILE` from overriding it in subprocesses.
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

function explicitConfigDirArgs(): string[] {
	const dir = credentialInputs().configDir;
	return dir !== "" ? ["--config-dir", dir] : [];
}

function posixSingleQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function explicitConfigDirCli(): string {
	const dir = credentialInputs().configDir;
	return dir === "" ? "" : ` --config-dir ${posixSingleQuote(dir)}`;
}

export function npxNeonArgs(command: string[]): string[] {
	return [
		"-y",
		"neon",
		...explicitProfileArgs(),
		...explicitConfigDirArgs(),
		...command,
	];
}

export function neonInitAgentCmd(data: Record<string, unknown>): string {
	return `neon init --agent${explicitProfileCli()}${explicitConfigDirCli()} --data '${JSON.stringify(data)}'`;
}
