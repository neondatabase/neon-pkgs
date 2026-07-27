import {
	type AppliedChange,
	type ComputeSettings,
	type Config,
	createNeonApiFromOptions,
	ErrorCode,
	type NeonApi,
	type NeonBranchSnapshot,
	PartialBranchCreateError,
	PlatformError,
	type PushResult,
	resolveConfig,
} from "@neon/config";
import type { FunctionBundler } from "./function-bundle.js";
import { type PulledBranchConfig, pullConfig } from "./pull-config.js";
import { type PushConfigOptions, pushConfig } from "./push-config.js";

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
	/** Neon API base URL. Falls back to `NEON_API_HOST`, then production. */
	apiHost?: string;
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
	/**
	 * Custom function bundler. Defaults to esbuild (`buildFunctionBundle`); inject
	 * your own to deploy functions without pulling esbuild's native binary into
	 * your build. See {@link FunctionBundler}.
	 */
	bundleFunction?: FunctionBundler;
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
		...(options.apiHost ? { apiHost: options.apiHost } : {}),
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
		...(options.apiHost ? { apiHost: options.apiHost } : {}),
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
		...(options.apiHost ? { apiHost: options.apiHost } : {}),
		...(options.updateExisting ? { updateExisting: true } : {}),
		...(options.allowProtectedBranch ? { allowProtectedBranch: true } : {}),
		...(options.bundleFunction
			? { bundleFunction: options.bundleFunction }
			: {}),
	});
}

/**
 * Options accepted by {@link createBranch}. Unlike {@link ConfigOperationOptions} this takes a
 * branch **name** (the branch does not exist yet) rather than an id.
 */
export interface CreateBranchOptions {
	/** Neon project id to create the branch in. **Required.** */
	projectId: string;
	/** Name of the branch to create. **Required.** Must not already exist on the project. */
	branchName: string;
	/** Neon API key. Falls back to `NEON_API_KEY` / neonctl credentials. Ignored when `api` is set. */
	apiKey?: string;
	/** Inject a custom NeonApi adapter (primarily for tests). */
	api?: NeonApi;
	/** Custom function bundler (defaults to esbuild). See {@link FunctionBundler}. */
	bundleFunction?: FunctionBundler;
}

/**
 * Result of {@link createBranch}: the created branch's id/name plus the {@link PushResult}
 * describing the policy that was applied to it.
 */
export interface CreateBranchResult {
	branchId: string;
	branchName: string;
	/** What applying the policy to the freshly created branch changed. */
	result: PushResult;
}

/**
 * Create a Neon branch **from a `neon.ts` policy** and bring it up with its declared
 * settings/infra in one step — the operation `neonctl checkout <new-name>` needs.
 *
 * The flow is the one a creation actually wants:
 *  1. Evaluate the policy for the new branch with `exists: false` (so creation-time tuning —
 *     `parent`, `ttl`, compute settings, `protected` — resolves instead of the
 *     "existing branch, leave as-is" path most policies guard with `if (branch.exists)`).
 *  2. Create the branch **with** that tuning: `parent`, `expires_at`, `protected`, and the
 *     compute settings all ride along on the single create call, which Neon validates as a
 *     whole. A setting it rejects therefore fails the creation outright, leaving nothing
 *     behind, rather than producing a branch that doesn't match the policy.
 *  3. {@link pushConfig} the rest onto it with `branchExists: false` — the services (Neon
 *     Auth, Data API, buckets, functions), which have no create-time equivalent because they
 *     are provisioned against an existing branch id.
 *
 * This is why `apply` alone couldn't do it: `apply` operates on an *existing* branch
 * (`exists: true`), so a policy keyed on `!branch.exists` never returns the creation tuning.
 *
 * `result.applied` covers both steps — the settings the create call carried are reported
 * exactly like the ones a push applies (see {@link settingsAppliedAtCreate}), so folding them
 * into the creation doesn't make them vanish from the summary.
 *
 * Throws {@link PlatformError} (`Conflict`) if a branch with `branchName` already exists, or
 * (`BranchNotFound`) if the policy names a `parent` that isn't on the project — both before
 * anything is created, as is a setting Neon rejects in step 2. Only step 3 can fail with a
 * branch already created; that throws {@link PartialBranchCreateError} carrying its id/name.
 */
export async function createBranch(
	config: Config,
	options: CreateBranchOptions,
): Promise<CreateBranchResult> {
	const api =
		options.api ??
		createNeonApiFromOptions(
			"createBranch",
			options.apiKey ? { apiKey: options.apiKey } : {},
		);
	const { projectId, branchName } = options;

	const branches = await api.listBranches(projectId);
	if (branches.some((b) => b.name === branchName)) {
		throw new PlatformError(
			ErrorCode.Conflict,
			`createBranch: a branch named "${branchName}" already exists on project ${projectId}. Pick a different name or check it out instead of creating it.`,
			{ details: { projectId, branchName } },
		);
	}

	// Evaluate the policy as a creation so `parent` (only settable at create time) resolves.
	const resolved = resolveConfig(config, {
		name: branchName,
		exists: false,
	});
	const parentId = resolveParentBranchId(
		resolved.parent,
		branches,
		branchName,
	);

	// Everything the policy can express *in the create call itself* goes into it. Neon
	// validates the whole request, so a value it rejects (a plan-gated suspend timeout, an
	// out-of-range autoscaling limit) fails with **no branch created** instead of leaving one
	// behind that silently diverges from the policy. Only the services below genuinely need an
	// existing branch id, which is what keeps them a second step.
	const expiresAt =
		resolved.ttlSeconds !== undefined
			? new Date(Date.now() + resolved.ttlSeconds * 1000).toISOString()
			: undefined;
	const computeSettings = resolved.postgres?.computeSettings;

	const { branch } = await api.createBranch(projectId, {
		name: branchName,
		...(parentId ? { parentId } : {}),
		...(expiresAt ? { expiresAt } : {}),
		...(resolved.protected !== undefined
			? { protected: resolved.protected }
			: {}),
		...(computeSettings ? { computeSettings } : {}),
	});

	const appliedAtCreate = settingsAppliedAtCreate({
		branchName: branch.name,
		...(resolved.parent !== undefined
			? { parentName: resolved.parent }
			: {}),
		...(expiresAt !== undefined ? { expiresAt } : {}),
		...(resolved.protected !== undefined
			? { isProtected: resolved.protected }
			: {}),
		...(computeSettings ? { computeSettings } : {}),
	});

	// Reconcile what the create call could not express as a new branch (`branchExists: false`):
	// the services/functions the policy declares. The settings above are already in place, so
	// push sees them satisfied and applies nothing for them.
	// `updateExisting`/`allowProtectedBranch` are safe here — there is no pre-existing state a
	// user would be surprised to see overridden.
	//
	// The branch is already created at this point, so a failure here (a service that can't be
	// provisioned, a function that fails to deploy, a transient API error) cannot be undone by
	// throwing: the branch would linger without its declared services, invisible to the caller.
	// Re-throw as PartialBranchCreateError so the id/name survive and the caller can keep the
	// branch usable while reporting that it diverges from the policy.
	let result: PushResult;
	try {
		result = await pushConfig(config, {
			projectId,
			branchId: branch.id,
			api,
			branchExists: false,
			updateExisting: true,
			allowProtectedBranch: true,
			...(options.bundleFunction
				? { bundleFunction: options.bundleFunction }
				: {}),
		});
	} catch (cause) {
		throw new PartialBranchCreateError(branch.id, branch.name, cause);
	}

	return {
		branchId: branch.id,
		branchName: branch.name,
		result: {
			...result,
			applied: mergeCreateSettings(appliedAtCreate, result.applied),
		},
	};
}

/**
 * Describe the policy settings the create call itself carried as {@link AppliedChange}s, keyed
 * by field.
 *
 * Applying a setting *at creation* rather than in a follow-up call must not make it disappear
 * from the report, so these are shaped exactly like the changes `pushConfig` returns for the
 * same fields — same `kind`/`identifier`/`details`, so every renderer already knows how to
 * print them and no caller needs to special-case a creation.
 */
const settingsAppliedAtCreate = (args: {
	branchName: string;
	/** The parent the *policy* named, omitted when the branch fell back to the project default. */
	parentName?: string;
	expiresAt?: string;
	isProtected?: boolean;
	computeSettings?: ComputeSettings;
}): Map<string, AppliedChange> => {
	const changes = new Map<string, AppliedChange>();
	const add = (field: string, details: Record<string, unknown>): void => {
		changes.set(field, {
			kind: "branch",
			action: "create",
			identifier: args.branchName,
			details: { field, ...details },
		});
	};
	if (args.parentName !== undefined) {
		add("parent", { parent: args.parentName });
	}
	if (args.expiresAt !== undefined) add("ttl", { expiresAt: args.expiresAt });
	if (args.isProtected !== undefined) {
		add("protected", { protected: args.isProtected });
	}
	if (args.computeSettings) {
		add("computeSettings", { settings: args.computeSettings });
	}
	return changes;
};

/**
 * Fold the create-time settings into what the push applied, reporting each field once.
 *
 * A field the create call already satisfied is a noop for the push, so the two normally don't
 * overlap. They do when the create didn't take (an API that ignores a create-time field, or
 * drift in the moments between the two calls) and the push applied it for real — the push
 * change is the one that describes what actually happened, so it wins.
 */
const mergeCreateSettings = (
	atCreate: Map<string, AppliedChange>,
	pushed: AppliedChange[],
): AppliedChange[] => {
	const pushedFields = new Set(
		pushed
			.filter((c) => c.kind === "branch" && c.action !== "noop")
			.map((c) => c.details?.field)
			.filter((field): field is string => typeof field === "string"),
	);
	const fromCreate = [...atCreate]
		.filter(([field]) => !pushedFields.has(field))
		.map(([, change]) => change);
	return [...fromCreate, ...pushed];
};

/**
 * Resolve the parent branch id for a new branch. A policy-declared `parent` (a branch name) is
 * looked up by name; an unknown name is a hard error. With no `parent`, fall back to the
 * project's default branch, or `undefined` (let the API pick the project default) when none is
 * marked default.
 */
function resolveParentBranchId(
	parentName: string | undefined,
	branches: NeonBranchSnapshot[],
	branchName: string,
): string | undefined {
	if (parentName !== undefined) {
		const match = branches.find((b) => b.name === parentName);
		if (!match) {
			throw new PlatformError(
				ErrorCode.BranchNotFound,
				`createBranch: the policy for "${branchName}" sets parent "${parentName}", but no branch with that name exists. Existing branches: ${
					branches.map((b) => b.name).join(", ") || "(none)"
				}.`,
				{
					details: {
						branchName,
						parent: parentName,
						available: branches.map((b) => b.name),
					},
				},
			);
		}
		return match.id;
	}
	return branches.find((b) => b.isDefault)?.id;
}
