import { type PulledBranchConfig, pullConfig } from "./pull-config.js";
import { type PushConfigOptions, pushConfig } from "./push-config.js";
import type { Config, PushResult } from "./types.js";

/**
 * Where to run the operation and how to authenticate. Filesystem- and env-agnostic: the
 * `projectId` and target branch are always passed explicitly by the caller (e.g. neonctl
 * resolves them from `.neon` / `NEON_*` and forwards them here).
 */
export interface ConfigOperationOptions {
	/**
	 * Neon project id. **Required** — the management API addresses branches through their
	 * project, so operations cannot run without it.
	 */
	projectId: string;
	/** Neon API key. Falls back to `NEON_API_KEY` / neonctl credentials. */
	apiKey?: string;
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
 * Pull a branch's live Neon state as a plain object (project + branch metadata and the
 * reverse-engineered `BranchConfig`). Network read only — never mutates.
 *
 * `branchId` selects the branch (id `br-…` or name) and is **required**.
 */
export async function pull(
	branchId: string,
	options: ConfigOperationOptions,
): Promise<PulledBranchConfig> {
	return pullConfig({
		projectId: options.projectId,
		branch: branchId,
		...(options.api ? { api: options.api } : {}),
		...(options.apiKey ? { apiKey: options.apiKey } : {}),
	});
}

/**
 * Compute what {@link deploy} would do for the given branch without mutating anything
 * (dry-run). Returns the full {@link PushResult} with the planned changes in `applied`
 * and any blocking drift in `conflicts`.
 *
 * `branchId` selects the branch (id `br-…` or name) and is **required**.
 */
export async function status(
	config: Config,
	branchId: string,
	options: ConfigOperationOptions,
): Promise<PushResult> {
	return pushConfig(config, {
		projectId: options.projectId,
		branch: branchId,
		dryRun: true,
		// Surface the full would-apply list as plan steps without mutating anything.
		updateExisting: true,
		...(options.api ? { api: options.api } : {}),
		...(options.apiKey ? { apiKey: options.apiKey } : {}),
	});
}

/**
 * Push a `neon.ts` policy to the given Neon branch and return the {@link PushResult}
 * describing what changed.
 *
 * `branchId` selects the branch (id `br-…` or name) and is **required**. Pass
 * `updateExisting` to auto-confirm overriding existing remote settings and
 * `allowProtectedBranch` to auto-confirm pushing to a protected branch; otherwise drift
 * is reported as a `PushConflictError`.
 *
 * Never creates projects or branches — both must already exist.
 */
export async function deploy(
	config: Config,
	branchId: string,
	options: DeployOptions,
): Promise<PushResult> {
	return pushConfig(config, {
		projectId: options.projectId,
		branch: branchId,
		...(options.api ? { api: options.api } : {}),
		...(options.apiKey ? { apiKey: options.apiKey } : {}),
		...(options.updateExisting ? { updateExisting: true } : {}),
		...(options.allowProtectedBranch ? { allowProtectedBranch: true } : {}),
	});
}
