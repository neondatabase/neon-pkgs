import {
	type AppliedChange,
	type Config,
	createNeonApiFromOptions,
	diffConfig,
	ErrorCode,
	type NeonApi,
	type NeonBranchSnapshot,
	type PlanStep,
	PlatformError,
	PushAbortedError,
	PushConflictError,
	type PushResult,
	type RemotePreviewState,
	type RemoteServiceState,
	type RemoteState,
	type ResolvedFunctionConfig,
	type ResolvedPreviewConfig,
	resolveConfig,
} from "@neon/config";
import type { FunctionBundler } from "./function-bundle.js";

/**
 * Default function bundler (esbuild), loaded lazily so that `buildFunctionBundle`
 * — and the esbuild it pulls in — only enters the module graph when a deploy
 * actually needs it AND no custom `bundleFunction` was injected. A consumer that
 * injects its own bundler never triggers this import, so esbuild can be dropped
 * from their build entirely.
 */
const defaultBundleFunction: FunctionBundler = async (
	fn: ResolvedFunctionConfig,
): Promise<Uint8Array> => {
	const { buildFunctionBundle } = await import("./function-bundle.js");
	return buildFunctionBundle(fn);
};

export interface PushConfigOptions {
	/**
	 * Neon project id. **Required** — the management API addresses every branch through
	 * its project, so there is no way to push without it. `pushConfig` never creates a
	 * project; resolve the id yourself (e.g. via neonctl) and pass it in.
	 */
	projectId: string;
	/**
	 * Neon branch id (`br-…`). **Required.** `pushConfig` never creates a branch — it must
	 * already exist on the project. Resolve names to ids before calling.
	 */
	branchId: string;
	/** Neon API key. Falls back to `NEON_API_KEY` / neonctl credentials. Ignored when `api` is supplied. */
	apiKey?: string;
	/** Neon API base URL. Falls back to `NEON_API_HOST`, then production. */
	apiHost?: string;
	/**
	 * Inject a custom NeonApi adapter. Primarily used by tests; production callers can rely
	 * on the default real adapter built from `apiKey`.
	 */
	api?: NeonApi;
	/**
	 * Whether to evaluate the policy as if the target branch **already exists** (the value of
	 * `branch.exists` passed to the `defineConfig({ branch: (branch) => … })` closure). Defaults to `true`.
	 *
	 * Set to `false` to evaluate the policy as a **branch creation** — used by
	 * {@link createBranch} right after it provisions a new branch, so creation-time tuning
	 * gated on `!branch.exists` (TTL, compute settings, `parent`) actually resolves instead of
	 * hitting the "existing branch, leave as-is" path. Only affects policy evaluation; the
	 * branch must still physically exist on Neon (`pushConfig` never creates one).
	 */
	branchExists?: boolean;
	/**
	 * Auto-confirm overriding existing remote settings.
	 *
	 * When `true`, mutable drift on the selected branch (TTL, `protected` flag, compute
	 * settings) is applied as actual mutations and the override-confirm prompt is
	 * skipped. When `false` (default) the behaviour depends on whether `confirm` is
	 * supplied:
	 *   - With `confirm`: the callback is asked whether to apply the override.
	 *   - Without `confirm`: drift is reported as a `PushConflictError` (legacy
	 *     non-interactive default — preserved so programmatic SDK callers don't
	 *     silently start mutating remote state).
	 */
	updateExisting?: boolean;
	/**
	 * Auto-confirm pushing to a protected branch.
	 *
	 * When `true`, no protected-branch confirmation is asked. When `false` (default):
	 *   - With `confirm`: the callback is asked.
	 *   - Without `confirm`: the push proceeds (legacy SDK default).
	 */
	allowProtectedBranch?: boolean;
	/**
	 * Optional confirmation callback. Invoked once with a single context object before
	 * any mutations run when the push needs confirmation: pushing to a protected
	 * branch (unless `allowProtectedBranch` is `true`) and/or applying mutable drift
	 * (unless `updateExisting` is `true`).
	 *
	 * Both prompts collapse into a single callback invocation when both apply, so the
	 * CLI can render one combined "are you sure?" prompt.
	 *
	 * Resolves to `true` to proceed, `false` to abort with {@link PushAbortedError}.
	 *
	 * Never invoked on `dryRun`.
	 */
	confirm?: (context: PushConfirmContext) => boolean | Promise<boolean>;
	/**
	 * Custom bundler for function source. Defaults to {@link buildFunctionBundle}
	 * (esbuild). Inject your own to deploy functions without this package pulling
	 * esbuild's native binary into your build — see {@link FunctionBundler}.
	 */
	bundleFunction?: FunctionBundler;
	/**
	 * When `true`, compute the full plan against the live remote state but **do not
	 * execute any mutations**. The resulting `PushResult.applied` array records every
	 * change that *would* run on a real push (with the same action / identifier / details
	 * shape, so the existing CLI summary formatter just works), and conflicts are
	 * reported instead of thrown.
	 *
	 * Used by `plan(config, branchId)` and any caller that wants a "would this push do
	 * something dangerous?" check before invoking `pushConfig` for real.
	 */
	dryRun?: boolean;
}

/**
 * Context handed to a {@link PushConfigOptions.confirm} callback. Both flags can be
 * `true` simultaneously when the push targets a protected branch *and* would override
 * existing settings — render a single combined prompt covering both reasons.
 */
export interface PushConfirmContext {
	/** Name of the target branch on Neon. */
	branchName: string;
	/**
	 * `true` when the target branch has the `protected` flag on Neon and the caller
	 * did not pass `allowProtectedBranch: true`.
	 */
	protectedBranch: boolean;
	/**
	 * `true` when the plan would override existing remote settings (TTL, `protected`
	 * flag, compute settings on an existing endpoint) and the caller did not pass
	 * `updateExisting: true`. Additive operations (enabling Neon Auth / Data API for
	 * the first time) are **not** counted here — those are unambiguous and never
	 * prompt.
	 */
	overrideUpdates: boolean;
}

/**
 * Push a Neon branch policy to a specific project + branch.
 *
 * Filesystem- and env-agnostic: the caller supplies an already-validated `Config` object
 * (from `defineConfig` / `loadConfigFromFile`) and explicit `projectId` + `branch` in
 * `options`. `pushConfig` performs no `.neon` lookups and reads no `NEON_*` env vars except the API credential/host resolution documented on `apiKey`/`apiHost`.
 *
 * It will **not** create a project or branch — both must already exist on Neon.
 */
export async function pushConfig(
	config: Config,
	options: PushConfigOptions,
): Promise<PushResult> {
	const api = options.api ?? createApiFromOptions(options);
	const projectId = options.projectId;

	const dryRun = options.dryRun === true;
	const updateExisting = options.updateExisting === true;
	const allowProtectedBranch = options.allowProtectedBranch === true;

	const remoteProject = await api.getProject(projectId);

	const [branches, endpoints] = await Promise.all([
		api.listBranches(remoteProject.id),
		api.listEndpoints(remoteProject.id),
	]);
	const branch = resolveRemoteBranch(options.branchId, branches);
	const resolved = resolveConfig(config, {
		name: branch.name,
		id: branch.id,
		exists: options.branchExists !== false,
		...(branch.parentId ? { parentId: branch.parentId } : {}),
		isDefault: branch.isDefault,
		isProtected: branch.protected,
		...(branch.expiresAt ? { expiresAt: branch.expiresAt } : {}),
	});
	const services = await resolveServiceState({
		api,
		projectId: remoteProject.id,
		branch,
		wantsAuth: resolved.authEnabled,
		wantsDataApi: resolved.dataApiEnabled,
	});
	const remote: RemoteState = {
		projectId: remoteProject.id,
		branch,
		endpoint: endpoints.find(
			(ep) => ep.type === "read_write" && ep.branchId === branch.id,
		),
		services,
	};
	// Only fetch Preview state when the policy actually uses it — and within that, only the
	// specific features the policy declares. So a policy that uses functions never probes
	// the AI Gateway, and `apply`/`plan` only fail on a Preview feature being unavailable
	// (404/503) when the policy actually asks for it.
	if (resolved.preview) {
		remote.preview = await resolvePreviewState({
			api,
			projectId: remoteProject.id,
			branchId: branch.id,
			desired: resolved.preview,
		});
	}

	// Always compute the plan with `updateExisting: true` so we can see what *would* be
	// overridden. The decision of whether to apply / prompt / fail is gated below using
	// the recorded steps.
	const diff = diffConfig(resolved, remote, { updateExisting: true });
	const overrideSteps = diff.plan.filter(isOverrideStep);
	const needsOverrideConfirm = overrideSteps.length > 0 && !updateExisting;
	const needsProtectedConfirm = branch.protected && !allowProtectedBranch;

	if (!dryRun && diff.conflicts.length > 0) {
		throw new PushConflictError(diff.conflicts);
	}

	if (!dryRun && (needsOverrideConfirm || needsProtectedConfirm)) {
		if (options.confirm) {
			const ok = await options.confirm({
				branchName: branch.name,
				protectedBranch: needsProtectedConfirm,
				overrideUpdates: needsOverrideConfirm,
			});
			if (!ok) {
				const reasons: ("protected-branch" | "override-updates")[] = [];
				if (needsProtectedConfirm) reasons.push("protected-branch");
				if (needsOverrideConfirm) reasons.push("override-updates");
				throw new PushAbortedError(branch.name, reasons);
			}
		} else if (needsOverrideConfirm) {
			// Legacy non-interactive fallback: surface the would-be drift as a
			// `PushConflictError` so programmatic callers that skipped both
			// `updateExisting` and `confirm` see the previous fail-fast behavior.
			const legacy = diffConfig(resolved, remote, {
				updateExisting: false,
			});
			throw new PushConflictError(legacy.conflicts);
		}
		// Protected branch + no confirm callback: legacy default proceeds without
		// any extra check (no programmatic regression).
	}

	const applied: AppliedChange[] = [
		{ kind: "branch", action: "noop", identifier: branch.name },
	];

	const branchById = new Map(branches.map((b) => [b.id, b] as const));
	const branchByName = new Map(branches.map((b) => [b.name, b] as const));

	for (const step of diff.plan) {
		const change = dryRun
			? synthesizeAppliedChange(step)
			: await applyStep(step, {
					api,
					remoteProjectId: remoteProject.id,
					branchById,
					branchByName,
					bundleFunction:
						options.bundleFunction ?? defaultBundleFunction,
				});
		applied.push(change);
	}

	// Surface each deployed function's invocation URL on its applied change so callers
	// (e.g. neonctl) can show users where to call it right after a push.
	await enrichFunctionInvocationUrls({
		api,
		projectId: remoteProject.id,
		branchId: branch.id,
		plan: diff.plan,
		applied,
		preview: remote.preview,
		dryRun,
	});

	const result: PushResult = {
		projectId: remoteProject.id,
		branchId: branch.id,
		branchName: branch.name,
		dryRun,
		applied,
		conflicts: diff.conflicts,
	};
	if (remoteProject.orgId) result.orgId = remoteProject.orgId;
	return result;
}

/**
 * `update-*` plan steps mutate existing remote state. `enable-*` steps are additive (no
 * existing resource to override) and never trigger the override-confirm prompt.
 */
function isOverrideStep(step: PlanStep): boolean {
	return (
		step.kind === "update-branch-ttl" ||
		step.kind === "update-branch-protected" ||
		step.kind === "update-endpoint" ||
		step.kind === "update-data-api"
	);
}

/**
 * Build an {@link AppliedChange} from a {@link PlanStep} without calling the Neon API.
 * Used by dry-run mode so callers see the same record shape they would on a live push,
 * just with no side effects. Identifiers are the branch names from the plan; any
 * sub-resource ids (`branchId`, `endpointId`) flow through unchanged when known.
 */
function synthesizeAppliedChange(step: PlanStep): AppliedChange {
	switch (step.kind) {
		case "update-branch-ttl":
			return {
				kind: "branch",
				action: "update",
				identifier: step.branchName,
				details: { field: "ttl", expiresAt: step.expiresAt },
			};
		case "update-branch-protected":
			return {
				kind: "branch",
				action: "update",
				identifier: step.branchName,
				details: { field: "protected", protected: step.protected },
			};
		case "update-endpoint":
			return {
				kind: "branch",
				action: "update",
				identifier: step.branchName,
				details: {
					field: "computeSettings",
					endpointId: step.endpointId,
					settings: step.settings,
				},
			};
		case "enable-auth":
			// Pure branch on/off toggle: the target branch is redundant (same on
			// every row) and the database is auto-derived, not policy-chosen — so
			// there is nothing meaningful to surface in the change summary.
			return { kind: "service", action: "create", identifier: "auth" };
		case "enable-data-api":
			return { kind: "service", action: "create", identifier: "dataApi" };
		case "update-data-api":
			return {
				kind: "service",
				action: "update",
				identifier: "dataApi",
				details: { field: "settings", settings: step.settings },
			};
		case "create-bucket":
			return {
				kind: "service",
				action: "create",
				identifier: `bucket:${step.bucketName}`,
				details: {
					bucketName: step.bucketName,
					accessLevel: step.accessLevel,
				},
			};
		case "deploy-function":
			return {
				kind: "service",
				// The first deployment creates the function; a later one updates it.
				action: step.functionExists ? "update" : "create",
				identifier: `function:${step.fn.slug}`,
				details: {
					slug: step.fn.slug,
					source: step.fn.source,
					runtime: step.fn.runtime,
				},
			};
	}
}

function createApiFromOptions(options: PushConfigOptions): NeonApi {
	return createNeonApiFromOptions("pushConfig", {
		...(options.apiKey ? { apiKey: options.apiKey } : {}),
		...(options.apiHost ? { apiHost: options.apiHost } : {}),
	});
}

function resolveRemoteBranch(
	branchId: string,
	branches: NeonBranchSnapshot[],
): NeonBranchSnapshot {
	const found = branches.find((b) => b.id === branchId);
	if (found) return found;
	throw new PlatformError(
		ErrorCode.BranchNotFound,
		[
			`pushConfig: branch id ${JSON.stringify(branchId)} does not exist on the project.`,
			`Available branches: ${branches.map((b) => `${b.name} (${b.id})`).join(", ") || "(none)"}.`,
			"Pass an existing branch id, or create the branch first with the neonctl CLI.",
		].join(" "),
		{ details: { branchId, available: branches.map((b) => b.id) } },
	);
}

/**
 * Pre-fetch the current state of branch-scoped integrations on the selected branch.
 */
async function resolveServiceState(args: {
	api: NeonApi;
	projectId: string;
	branch: NeonBranchSnapshot;
	wantsAuth: boolean;
	wantsDataApi: boolean;
}): Promise<RemoteServiceState> {
	const { api, projectId, branch, wantsAuth, wantsDataApi } = args;
	if (!wantsAuth && !wantsDataApi) {
		return {
			databaseName: "neondb",
			authEnabled: false,
			dataApiEnabled: false,
		};
	}

	const databaseName = await pickServiceDatabaseName(
		api,
		projectId,
		branch.id,
	);

	const [auth, dataApi] = await Promise.all([
		wantsAuth
			? api.getNeonAuth(projectId, branch.id)
			: Promise.resolve(null),
		wantsDataApi
			? api.getNeonDataApi(projectId, branch.id, databaseName)
			: Promise.resolve(null),
	]);
	const result: RemoteServiceState = {
		databaseName,
		authEnabled: auth !== null,
		dataApiEnabled: dataApi !== null,
	};
	// Carry the current Data API settings (when reported) so the diff can detect settings
	// drift and plan an update. `null` distinguishes "enabled but not reported" from "absent".
	if (dataApi) result.dataApiSettings = dataApi.settings ?? null;
	return result;
}

/**
 * Pre-fetch the current state of branch-scoped Preview features (buckets, functions) so the
 * diff can be computed additively. Only called when the policy has a `preview` block.
 *
 * The AI Gateway is not probed: it is always available (credential-gated, not per-branch
 * provisioned), so `preview.aiGateway` produces no plan step — it only drives the branch
 * credential's `ai_gateway:invoke` scope and the gateway env vars (`@neon/env`).
 */
async function resolvePreviewState(args: {
	api: NeonApi;
	projectId: string;
	branchId: string;
	desired: ResolvedPreviewConfig;
}): Promise<RemotePreviewState> {
	const { api, projectId, branchId, desired } = args;
	// Read only the Preview features the policy declares: undeclared features can never
	// produce a plan step (see diffConfig), so probing them is pure waste — and would make
	// `plan`/`apply` fail on a feature the user didn't ask for if it's unavailable in the
	// project/region. A declared-but-unavailable feature still throws (failing the push),
	// which is the intended signal to enable it first.
	const [buckets, functions] = await Promise.all([
		desired.buckets.length > 0
			? api.listBranchBuckets(projectId, branchId)
			: Promise.resolve([]),
		desired.functions.length > 0
			? api.listBranchFunctions(projectId, branchId)
			: Promise.resolve([]),
	]);
	return { buckets, functions };
}

/**
 * Resolve the database name for a Data API integration. Auto-pick when the branch has
 * exactly one database; otherwise fall back to Neon's default (`neondb`) so the call
 * stays useful even on branches with multiple databases — push doesn't have a way to
 * surface a "pick one" prompt the way `fetchEnv` does.
 */
async function pickServiceDatabaseName(
	api: NeonApi,
	projectId: string,
	branchId: string,
): Promise<string> {
	const databases = await api.listBranchDatabases(projectId, branchId);
	if (databases.length === 1) return databases[0].name;
	const neondb = databases.find((d) => d.name === "neondb");
	if (neondb) return neondb.name;
	return databases[0]?.name ?? "neondb";
}

interface ApplyContext {
	api: NeonApi;
	remoteProjectId: string;
	branchById: Map<string, NeonBranchSnapshot>;
	branchByName: Map<string, NeonBranchSnapshot>;
	bundleFunction: FunctionBundler;
}

async function applyStep(
	step: PlanStep,
	ctx: ApplyContext,
): Promise<AppliedChange> {
	switch (step.kind) {
		case "update-branch-ttl": {
			const updated = await ctx.api.updateBranch(
				ctx.remoteProjectId,
				step.branchId,
				{
					expiresAt: step.expiresAt ?? null,
				},
			);
			ctx.branchById.set(updated.id, updated);
			ctx.branchByName.set(updated.name, updated);
			return {
				kind: "branch",
				action: "update",
				identifier: updated.name,
				details: { field: "ttl", expiresAt: step.expiresAt },
			};
		}
		case "update-branch-protected": {
			const updated = await ctx.api.updateBranch(
				ctx.remoteProjectId,
				step.branchId,
				{ protected: step.protected },
			);
			ctx.branchById.set(updated.id, updated);
			ctx.branchByName.set(updated.name, updated);
			return {
				kind: "branch",
				action: "update",
				identifier: updated.name,
				details: { field: "protected", protected: step.protected },
			};
		}
		case "update-endpoint": {
			const updated = await ctx.api.updateEndpoint(
				ctx.remoteProjectId,
				step.endpointId,
				step.settings,
			);
			return {
				kind: "branch",
				action: "update",
				identifier: step.branchName,
				details: {
					field: "computeSettings",
					endpointId: updated.id,
					settings: step.settings,
				},
			};
		}
		case "enable-auth": {
			await ctx.api.enableNeonAuth(ctx.remoteProjectId, step.branchId, {
				...(step.databaseName
					? { databaseName: step.databaseName }
					: {}),
			});
			return {
				kind: "service",
				action: "create",
				identifier: "auth",
			};
		}
		case "enable-data-api": {
			await ctx.api.enableProjectBranchDataApi(
				ctx.remoteProjectId,
				step.branchId,
				step.databaseName,
				step.input,
			);
			return {
				kind: "service",
				action: "create",
				identifier: "dataApi",
			};
		}
		case "update-data-api": {
			await ctx.api.updateProjectBranchDataApi(
				ctx.remoteProjectId,
				step.branchId,
				step.databaseName,
				step.settings,
			);
			return {
				kind: "service",
				action: "update",
				identifier: "dataApi",
				details: { field: "settings", settings: step.settings },
			};
		}
		case "create-bucket": {
			await ctx.api.createBranchBucket(
				ctx.remoteProjectId,
				step.branchId,
				{ name: step.bucketName, accessLevel: step.accessLevel },
			);
			return {
				kind: "service",
				action: "create",
				identifier: `bucket:${step.bucketName}`,
				details: {
					bucketName: step.bucketName,
					accessLevel: step.accessLevel,
				},
			};
		}
		case "deploy-function": {
			const bundle = await ctx.bundleFunction(step.fn);
			// Neon creates the function on its first deployment — there is no separate
			// create call — so a single deploy both creates (when absent) and ships code.
			const deployment = await ctx.api.deployBranchFunction(
				ctx.remoteProjectId,
				step.branchId,
				step.fn.slug,
				{
					bundle,
					runtime: step.fn.runtime,
					environment: step.fn.env,
				},
			);
			return {
				kind: "service",
				action: step.functionExists ? "update" : "create",
				identifier: `function:${step.fn.slug}`,
				details: {
					slug: step.fn.slug,
					source: step.fn.source,
					runtime: step.fn.runtime,
					deploymentId: deployment.id,
				},
			};
		}
	}
}

/**
 * Add each deployed function's invocation URL to its applied-change `details` so callers
 * (e.g. neonctl) can show users where to call the function right after a push.
 *
 * The URL is read from the preview snapshot already fetched for the diff, which lists every
 * existing function with its `invocationUrl`. A function created by its *first* deployment in
 * this push is not in that snapshot, so when one is present we re-list the branch's functions
 * once to learn its freshly-minted URL. Skipped on dry-run (nothing was created) and
 * best-effort otherwise: a failed re-list omits the URL rather than failing a push that has
 * already applied.
 */
async function enrichFunctionInvocationUrls(args: {
	api: NeonApi;
	projectId: string;
	branchId: string;
	plan: PlanStep[];
	applied: AppliedChange[];
	preview: RemotePreviewState | undefined;
	dryRun: boolean;
}): Promise<void> {
	const { api, projectId, branchId, plan, applied, preview, dryRun } = args;
	const deployedSlugs = plan.flatMap((step) =>
		step.kind === "deploy-function" ? [step.fn.slug] : [],
	);
	if (deployedSlugs.length === 0) return;

	const urlBySlug = new Map<string, string>(
		(preview?.functions ?? []).map(
			(fn) => [fn.slug, fn.invocationUrl] as const,
		),
	);

	// A first-time deploy creates the function, so its URL isn't in the pre-fetch; re-list
	// once when any deployed slug is still missing a URL.
	const hasMissingUrl = deployedSlugs.some((slug) => !urlBySlug.has(slug));
	if (hasMissingUrl && !dryRun) {
		try {
			for (const fn of await api.listBranchFunctions(
				projectId,
				branchId,
			)) {
				urlBySlug.set(fn.slug, fn.invocationUrl);
			}
		} catch {
			// Push already succeeded; surface what we can rather than failing here.
		}
	}

	for (const change of applied) {
		const slug = functionSlugFromIdentifier(change.identifier);
		if (slug === undefined) continue;
		const invocationUrl = urlBySlug.get(slug);
		if (invocationUrl === undefined) continue;
		change.details = { ...change.details, invocationUrl };
	}
}

/** Pull the function slug out of a `function:<slug>` applied-change identifier. */
function functionSlugFromIdentifier(identifier: string): string | undefined {
	const prefix = "function:";
	return identifier.startsWith(prefix)
		? identifier.slice(prefix.length)
		: undefined;
}
