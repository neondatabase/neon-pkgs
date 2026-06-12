import type {
	EnableDataApiInput,
	NeonBranchSnapshot,
	NeonBucketSnapshot,
	NeonEndpointSnapshot,
	NeonFunctionSnapshot,
} from "./neon-api.js";
import type {
	BucketAccessLevel,
	ComputeSettings,
	ConflictReport,
	DataApiSettings,
	ResolvedBranchConfig,
	ResolvedDataApiConfig,
	ResolvedFunctionConfig,
} from "./types.js";

/**
 * A planned action to perform a single mutation against the Neon API. The diff engine
 * produces a list of these for `pushConfig` to execute (or report).
 */
export type PlanStep =
	| {
			kind: "update-branch-ttl";
			projectId: string;
			branchId: string;
			branchName: string;
			expiresAt: string | null;
	  }
	| {
			kind: "update-branch-protected";
			projectId: string;
			branchId: string;
			branchName: string;
			protected: boolean;
	  }
	| {
			kind: "update-endpoint";
			projectId: string;
			branchName: string;
			endpointId: string;
			settings: ComputeSettings;
	  }
	| {
			kind: "enable-auth";
			projectId: string;
			branchId: string;
			branchName: string;
			databaseName?: string;
	  }
	| {
			kind: "enable-data-api";
			projectId: string;
			branchId: string;
			branchName: string;
			databaseName: string;
			/** Create-time auth wiring + initial settings from the policy. */
			input?: EnableDataApiInput;
	  }
	| {
			/**
			 * Reconcile the runtime settings of an already-enabled Data API integration.
			 * Only `settings` are mutable post-create, so this is the lone Data API
			 * *update* step — and it is an override (requires `updateExisting`).
			 */
			kind: "update-data-api";
			projectId: string;
			branchId: string;
			branchName: string;
			databaseName: string;
			settings: DataApiSettings;
	  }
	| {
			kind: "create-bucket";
			projectId: string;
			branchId: string;
			branchName: string;
			bucketName: string;
			accessLevel: BucketAccessLevel;
	  }
	| {
			/**
			 * Deploy code to a function. Planned for every desired function — deployments are
			 * versioned and the newest becomes active, so a push ships the current source each
			 * time. Neon has no separate "create function" endpoint: the first deployment to a
			 * slug creates the function. `functionExists` therefore only drives whether this
			 * surfaces as a `create` (first deploy) or an `update` (re-deploy).
			 */
			kind: "deploy-function";
			projectId: string;
			branchId: string;
			branchName: string;
			fn: ResolvedFunctionConfig;
			/** Whether the function already existed remotely when the plan was computed. */
			functionExists: boolean;
	  };

export interface RemoteServiceState {
	databaseName: string;
	authEnabled: boolean;
	dataApiEnabled: boolean;
	/**
	 * Current Data API runtime settings, when the integration is enabled and the API reports
	 * them (SubZero only). `null`/absent means "not reported" — settings drift can't be
	 * computed, so no update step is planned.
	 */
	dataApiSettings?: DataApiSettings | null;
}

/**
 * Snapshot of the branch's current Preview-feature state. Absent (`undefined`) when the
 * policy has no `preview` block — `pushConfig` only fetches this when needed.
 */
export interface RemotePreviewState {
	buckets: NeonBucketSnapshot[];
	functions: NeonFunctionSnapshot[];
}

export interface RemoteState {
	projectId: string;
	branch: NeonBranchSnapshot;
	endpoint?: NeonEndpointSnapshot;
	services: RemoteServiceState;
	preview?: RemotePreviewState;
}

export interface DiffOptions {
	/**
	 * Apply mutable drift on the selected branch as plan steps instead of conflicts.
	 * Default: `false`.
	 */
	updateExisting: boolean;
}

export interface DiffResult {
	plan: PlanStep[];
	conflicts: ConflictReport[];
}

/**
 * Diff desired branch policy against the selected remote branch. Pure function.
 */
export function diffConfig(
	config: ResolvedBranchConfig,
	remote: RemoteState,
	options: DiffOptions,
): DiffResult {
	const conflicts: ConflictReport[] = [];
	const plan: PlanStep[] = [];
	diffBranchConfig({ config, remote, options, plan, conflicts });
	diffServices({ config, remote, options, plan, conflicts });
	diffPreview({ config, remote, plan });
	return { plan, conflicts };
}

/**
 * Plan Preview features (functions, buckets). Like {@link diffServices}, this is
 * **additive**: it creates desired buckets and (re-)deploys functions, but never deletes
 * them. Teardown is destructive, so it stays explicit/manual — matching the existing
 * auth / dataApi behaviour.
 *
 * The AI Gateway is intentionally NOT planned here: it is always available on a branch
 * (credential-gated, not per-branch provisioned), so `preview.aiGateway` produces no plan
 * step — it only drives the branch credential's `ai_gateway:invoke` scope and the gateway
 * env vars (`@neondatabase/env`). There is nothing to create, and nothing to probe.
 *
 * Functions are always (re-)deployed: deployments are versioned and the newest becomes
 * active, so each push ships the current source. There is no separate create step — Neon
 * creates the function on its first deployment — so a single `deploy-function` step is
 * emitted per desired function, carrying `functionExists` so the apply can report it as a
 * create (first deploy) or an update (re-deploy).
 */
function diffPreview(args: {
	config: ResolvedBranchConfig;
	remote: RemoteState;
	plan: PlanStep[];
}): void {
	const { config, remote, plan } = args;
	const preview = config.preview;
	if (!preview) return;
	// `remote.preview` is only fetched when the policy has a preview block; treat a missing
	// snapshot as "nothing exists yet" so the diff is still well-defined.
	const state: RemotePreviewState = remote.preview ?? {
		buckets: [],
		functions: [],
	};

	for (const bucket of preview.buckets) {
		if (state.buckets.some((b) => b.name === bucket.name)) continue;
		plan.push({
			kind: "create-bucket",
			projectId: remote.projectId,
			branchId: remote.branch.id,
			branchName: remote.branch.name,
			bucketName: bucket.name,
			accessLevel: bucket.access,
		});
	}

	for (const fn of preview.functions) {
		const exists = state.functions.some((f) => f.slug === fn.slug);
		// Neon creates the function on its first deployment (there is no separate create
		// endpoint), so always emit a single deploy step and let `functionExists` decide
		// whether it is reported as a create or an update.
		plan.push({
			kind: "deploy-function",
			projectId: remote.projectId,
			branchId: remote.branch.id,
			branchName: remote.branch.name,
			fn,
			functionExists: exists,
		});
	}
}

/**
 * Plan branch-scoped integrations. Enabling is additive (no existing resource to override).
 * The Data API is the one integration that also has a reconcilable *update*: its runtime
 * `settings` can drift once enabled, and reconciling them is an override (gated on
 * `updateExisting`, like compute/TTL/protected). The auth provider / JWKS wiring is fixed at
 * enable time, so it is never updated here. Disabling stays explicit/manual (destructive).
 */
function diffServices(args: {
	config: ResolvedBranchConfig;
	remote: RemoteState;
	options: DiffOptions;
	plan: PlanStep[];
	conflicts: ConflictReport[];
}): void {
	const { config, remote, options, plan, conflicts } = args;
	const state = remote.services;
	if (config.authEnabled && !state.authEnabled) {
		const step: PlanStep = {
			kind: "enable-auth",
			projectId: remote.projectId,
			branchId: remote.branch.id,
			branchName: remote.branch.name,
		};
		if (state.databaseName) step.databaseName = state.databaseName;
		plan.push(step);
	}
	if (config.dataApiEnabled) {
		diffDataApi({ config, remote, options, plan, conflicts });
	}
}

/**
 * Plan the Data API: a first-time **enable** (carrying the create-time auth wiring +
 * settings), or — when it already exists — a **settings update** if the policy's settings
 * drift from the remote. The update is an override: applied as a plan step under
 * `updateExisting`, otherwise reported as a conflict.
 */
function diffDataApi(args: {
	config: ResolvedBranchConfig;
	remote: RemoteState;
	options: DiffOptions;
	plan: PlanStep[];
	conflicts: ConflictReport[];
}): void {
	const { config, remote, options, plan, conflicts } = args;
	const state = remote.services;
	const desired = config.dataApi;

	if (!state.dataApiEnabled) {
		const step: PlanStep = {
			kind: "enable-data-api",
			projectId: remote.projectId,
			branchId: remote.branch.id,
			branchName: remote.branch.name,
			databaseName: state.databaseName,
		};
		const input = desired ? enableInputFromResolved(desired) : undefined;
		if (input) step.input = input;
		plan.push(step);
		return;
	}

	// Already enabled: the only reconcilable change is its runtime settings.
	const desiredSettings = desired?.settings;
	if (!desiredSettings) return;
	if (!dataApiSettingsDiffer(desiredSettings, state.dataApiSettings)) return;

	if (options.updateExisting) {
		plan.push({
			kind: "update-data-api",
			projectId: remote.projectId,
			branchId: remote.branch.id,
			branchName: remote.branch.name,
			databaseName: state.databaseName,
			settings: desiredSettings,
		});
	} else {
		conflicts.push({
			kind: "branch",
			identifier: remote.branch.name,
			field: "dataApi.settings",
			current: state.dataApiSettings ?? undefined,
			desired: desiredSettings,
			reason: "Existing Data API has different settings. Pass `updateExisting: true` (SDK) or `--update-existing` (CLI) to apply.",
		});
	}
}

/** Build the create-time {@link EnableDataApiInput} from a resolved Data API config. */
function enableInputFromResolved(
	resolved: ResolvedDataApiConfig,
): EnableDataApiInput {
	const input: EnableDataApiInput = { authProvider: resolved.authProvider };
	if (resolved.jwksUrl !== undefined) input.jwksUrl = resolved.jwksUrl;
	if (resolved.providerName !== undefined)
		input.providerName = resolved.providerName;
	if (resolved.jwtAudience !== undefined)
		input.jwtAudience = resolved.jwtAudience;
	if (resolved.settings) input.settings = resolved.settings;
	return input;
}

/** The camelCase keys of {@link DataApiSettings}, used to compare desired vs remote settings. */
const DATA_API_SETTING_KEYS = [
	"dbAggregatesEnabled",
	"dbAnonRole",
	"dbExtraSearchPath",
	"dbMaxRows",
	"dbSchemas",
	"jwtRoleClaimKey",
	"jwtCacheMaxLifetime",
	"openapiMode",
	"serverCorsAllowedOrigins",
	"serverTimingEnabled",
] as const satisfies ReadonlyArray<keyof DataApiSettings>;

/**
 * Whether the policy's Data API `settings` differ from the remote ones. Only the keys the
 * policy actually set are compared (so unset fields never count as drift). When the remote
 * settings are not reported (`null`/absent — non-SubZero), drift can't be computed and this
 * returns `false` so no spurious update is planned.
 */
function dataApiSettingsDiffer(
	desired: DataApiSettings,
	current: DataApiSettings | null | undefined,
): boolean {
	if (!current) return false;
	for (const key of DATA_API_SETTING_KEYS) {
		if (desired[key] === undefined) continue;
		if (JSON.stringify(desired[key]) !== JSON.stringify(current[key])) {
			return true;
		}
	}
	return false;
}

interface BranchConfigArgs {
	config: ResolvedBranchConfig;
	remote: RemoteState;
	options: DiffOptions;
	plan: PlanStep[];
	conflicts: ConflictReport[];
}

function diffBranchConfig(args: BranchConfigArgs): void {
	const { config, remote, options, plan, conflicts } = args;
	const branchName = remote.branch.name;
	const computeSettings = config.postgres?.computeSettings;

	if (computeSettings) {
		const endpoint = remote.endpoint;
		if (!endpoint) {
			conflicts.push({
				kind: "branch",
				identifier: branchName,
				field: "endpoint",
				current: undefined,
				desired: computeSettings,
				reason: "Branch has no read-write endpoint; cannot apply compute settings.",
			});
		} else {
			const drift = computeDriftBetween(computeSettings, endpoint);
			if (drift) {
				if (options.updateExisting) {
					plan.push({
						kind: "update-endpoint",
						projectId: remote.projectId,
						branchName,
						endpointId: endpoint.id,
						settings: computeSettings,
					});
				} else {
					conflicts.push({
						kind: "branch",
						identifier: branchName,
						field: "computeSettings",
						current: drift.current,
						desired: drift.desired,
						reason: "Existing branch has different compute settings. Pass `updateExisting: true` (SDK) or `--update-existing` (CLI) to apply.",
					});
				}
			}
		}
	}

	if (
		config.protected !== undefined &&
		config.protected !== remote.branch.protected
	) {
		if (options.updateExisting) {
			plan.push({
				kind: "update-branch-protected",
				projectId: remote.projectId,
				branchId: remote.branch.id,
				branchName,
				protected: config.protected,
			});
		} else {
			conflicts.push({
				kind: "branch",
				identifier: branchName,
				field: "protected",
				current: remote.branch.protected,
				desired: config.protected,
				reason: "Existing branch has a different `protected` flag. Pass `updateExisting: true` (SDK) or `--update-existing` (CLI) to apply.",
			});
		}
	}

	if (config.ttlSeconds !== undefined) {
		const current = remote.branch.expiresAt
			? Math.max(
					0,
					Math.round(
						(Date.parse(remote.branch.expiresAt) - Date.now()) /
							1000,
					),
				)
			: undefined;
		if (
			current === undefined ||
			Math.abs(current - config.ttlSeconds) > 30
		) {
			const expiresAt = new Date(
				Date.now() + config.ttlSeconds * 1000,
			).toISOString();
			if (options.updateExisting) {
				plan.push({
					kind: "update-branch-ttl",
					projectId: remote.projectId,
					branchId: remote.branch.id,
					branchName,
					expiresAt,
				});
			} else {
				conflicts.push({
					kind: "branch",
					identifier: branchName,
					field: "ttl",
					current: remote.branch.expiresAt,
					desired: expiresAt,
					reason: "Existing branch has a different TTL. Pass `updateExisting: true` (SDK) or `--update-existing` (CLI) to apply.",
				});
			}
		}
	}
}

function computeDriftBetween(
	desired: ComputeSettings,
	endpoint: NeonEndpointSnapshot,
): {
	current: Partial<ComputeSettings>;
	desired: Partial<ComputeSettings>;
} | null {
	const currentDrift: Partial<ComputeSettings> = {};
	const desiredDrift: Partial<ComputeSettings> = {};
	let drift = false;

	if (
		desired.autoscalingLimitMinCu !== undefined &&
		desired.autoscalingLimitMinCu !== endpoint.autoscalingLimitMinCu
	) {
		currentDrift.autoscalingLimitMinCu = endpoint.autoscalingLimitMinCu;
		desiredDrift.autoscalingLimitMinCu = desired.autoscalingLimitMinCu;
		drift = true;
	}
	if (
		desired.autoscalingLimitMaxCu !== undefined &&
		desired.autoscalingLimitMaxCu !== endpoint.autoscalingLimitMaxCu
	) {
		currentDrift.autoscalingLimitMaxCu = endpoint.autoscalingLimitMaxCu;
		desiredDrift.autoscalingLimitMaxCu = desired.autoscalingLimitMaxCu;
		drift = true;
	}
	if (
		desired.suspendTimeout !== undefined &&
		desired.suspendTimeout !== endpoint.suspendTimeout
	) {
		currentDrift.suspendTimeout = endpoint.suspendTimeout;
		desiredDrift.suspendTimeout = desired.suspendTimeout;
		drift = true;
	}
	return drift ? { current: currentDrift, desired: desiredDrift } : null;
}
