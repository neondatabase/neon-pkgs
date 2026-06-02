import { type PulledBranchConfig, pullConfig } from "./pull-config.js";
import { type PushConfigOptions, pushConfig } from "./push-config.js";
import type { Config, PushResult } from "./types.js";

/**
 * Where to run the operation and how to authenticate. Filesystem- and env-agnostic: the
 * `projectId` and `branchId` are always passed explicitly by the caller (e.g. neonctl
 * resolves them from `.neon` / `NEON_*` and forwards them here).
 */
export interface ConfigOperationOptions {
	/**
	 * Neon project id. **Required** — the management API addresses branches through their
	 * project, so operations cannot run without it.
	 */
	projectId: string;
	/**
	 * Neon branch id (`br-…`). **Required.** Must already exist on the project; resolve
	 * branch names to ids before calling.
	 */
	branchId: string;
	/** Neon API key. Falls back to `NEON_API_KEY` / neonctl credentials. */
	apiKey?: string;
	/** Inject a custom NeonApi adapter (primarily for tests). */
	api?: PushConfigOptions["api"];
}

/**
 * Options accepted by {@link apply} on top of {@link ConfigOperationOptions}.
 */
export interface ApplyOptions extends ConfigOperationOptions {
	/**
	 * Auto-confirm overriding existing remote settings (TTL, `protected`, compute
	 * settings) on the selected branch. Without it, drift is reported as a conflict.
	 */
	updateExisting?: boolean;
	/** Auto-confirm applying to a branch marked `protected` on Neon. */
	allowProtectedBranch?: boolean;
}

/**
 * Read a branch's live Neon state as a plain object (project + branch metadata and the
 * reverse-engineered `BranchConfig`). Network read only — never mutates.
 *
 * `projectId` and `branchId` are **required** (both in `options`).
 */
export async function inspect(
	options: ConfigOperationOptions,
): Promise<PulledBranchConfig> {
	return pullConfig({
		projectId: options.projectId,
		branchId: options.branchId,
		...(options.api ? { api: options.api } : {}),
		...(options.apiKey ? { apiKey: options.apiKey } : {}),
	});
}

/**
 * Compute what {@link apply} would do for the given branch without mutating anything
 * (dry-run plan). Returns the full {@link PushResult} with the planned changes in
 * `applied` and any blocking drift in `conflicts` — the Neon equivalent of
 * `terraform plan`.
 *
 * `projectId` and `branchId` are **required** (both in `options`).
 */
export async function plan(
	config: Config,
	options: ConfigOperationOptions,
): Promise<PushResult> {
	return pushConfig(config, {
		projectId: options.projectId,
		branchId: options.branchId,
		dryRun: true,
		// Surface the full would-apply list as plan steps without mutating anything.
		updateExisting: true,
		...(options.api ? { api: options.api } : {}),
		...(options.apiKey ? { apiKey: options.apiKey } : {}),
	});
}

/**
 * Apply a `neon.ts` policy to the given Neon branch and return the {@link PushResult}
 * describing what changed — the Neon equivalent of `terraform apply`.
 *
 * `projectId` and `branchId` are **required** (both in `options`). Pass `updateExisting`
 * to auto-confirm overriding existing remote settings and `allowProtectedBranch` to
 * auto-confirm applying to a protected branch; otherwise drift is reported as a
 * `PushConflictError`.
 *
 * Never creates projects or branches — both must already exist.
 */
export async function apply(
	config: Config,
	options: ApplyOptions,
): Promise<PushResult> {
	return pushConfig(config, {
		projectId: options.projectId,
		branchId: options.branchId,
		...(options.api ? { api: options.api } : {}),
		...(options.apiKey ? { apiKey: options.apiKey } : {}),
		...(options.updateExisting ? { updateExisting: true } : {}),
		...(options.allowProtectedBranch ? { allowProtectedBranch: true } : {}),
	});
}
