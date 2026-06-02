import { type PulledBranchConfig, pullConfig } from "./pull-config.js";
import { type PushConfigOptions, pushConfig } from "./push-config.js";
import type { Config, PushResult } from "./types.js";

/**
 * Common options shared by the {@link status} / {@link deploy} entry points. These are a
 * thin, intent-revealing subset of {@link PushConfigOptions}; everything resolves through
 * the same project/branch/api-key chain as the rest of the package.
 */
export interface ConfigOperationOptions {
	/** Neon API key. Falls back to `NEON_API_KEY` / neonctl credentials. */
	apiKey?: string;
	/** Explicit project id. Overrides `NEON_PROJECT_ID` / `.neon[/project.json]`. */
	projectId?: string;
	/** Working directory for context / config file lookups. Defaults to `process.cwd()`. */
	cwd?: string;
	/** Inject a custom NeonApi adapter (primarily for tests). */
	api?: PushConfigOptions["api"];
}

/**
 * Options accepted by {@link deploy} on top of {@link ConfigOperationOptions}.
 */
export interface DeployOptions extends ConfigOperationOptions {
	/**
	 * Auto-confirm overriding existing remote settings (TTL, `protected`, compute
	 * settings) on the selected branch. Without it, drift is reported as a conflict.
	 */
	updateExisting?: boolean;
	/** Auto-confirm deploying to a branch marked `protected` on Neon. */
	allowProtectedBranch?: boolean;
}

/**
 * Pull the selected branch's live Neon state as a plain object (project + branch metadata
 * and the reverse-engineered `BranchConfig`). Network read only — never mutates.
 *
 * `branchId` selects the branch (id `br-…` or name). Omit it to use the project's default
 * branch / the branch resolved from `NEON_BRANCH_ID` / `.neon[/project.json]`.
 */
export async function pull(
	branchId?: string,
	options: ConfigOperationOptions = {},
): Promise<PulledBranchConfig> {
	return pullConfig({
		...(options.api ? { api: options.api } : {}),
		...(options.apiKey ? { apiKey: options.apiKey } : {}),
		...(options.projectId ? { projectId: options.projectId } : {}),
		...(options.cwd ? { cwd: options.cwd } : {}),
		...(branchId ? { branch: branchId } : {}),
	});
}

/**
 * Compute what {@link deploy} would do for the selected branch without mutating anything
 * (dry-run). Returns the full {@link PushResult} with the planned changes in `applied`
 * and any blocking drift in `conflicts`.
 *
 * `branchId` selects the branch (id `br-…` or name). Omit it to use the branch resolved
 * from `NEON_BRANCH_ID` / `.neon[/project.json]`.
 */
export async function status(
	config: Config,
	branchId?: string,
	options: ConfigOperationOptions = {},
): Promise<PushResult> {
	return pushConfig(config, {
		dryRun: true,
		// Surface the full would-apply list as plan steps without mutating anything.
		updateExisting: true,
		...(options.api ? { api: options.api } : {}),
		...(options.apiKey ? { apiKey: options.apiKey } : {}),
		...(options.projectId ? { projectId: options.projectId } : {}),
		...(options.cwd ? { cwd: options.cwd } : {}),
		...(branchId ? { branch: branchId } : {}),
	});
}

/**
 * Push the local `neon.ts` policy to the selected Neon branch and return the
 * {@link PushResult} describing what changed.
 *
 * `branchId` selects the branch (id `br-…` or name). Pass `updateExisting` to auto-confirm
 * overriding existing remote settings and `allowProtectedBranch` to auto-confirm pushing
 * to a protected branch; otherwise drift is reported as a `PushConflictError`.
 *
 * Never creates projects or branches.
 */
export async function deploy(
	config: Config,
	branchId?: string,
	options: DeployOptions = {},
): Promise<PushResult> {
	return pushConfig(config, {
		...(options.api ? { api: options.api } : {}),
		...(options.apiKey ? { apiKey: options.apiKey } : {}),
		...(options.projectId ? { projectId: options.projectId } : {}),
		...(options.cwd ? { cwd: options.cwd } : {}),
		...(branchId ? { branch: branchId } : {}),
		...(options.updateExisting ? { updateExisting: true } : {}),
		...(options.allowProtectedBranch ? { allowProtectedBranch: true } : {}),
	});
}
