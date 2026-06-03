import { createNeonApiFromOptions } from "./auth.js";
import { resolveConfig } from "./define-config.js";
import {
	diffConfig,
	type PlanStep,
	type RemotePreviewState,
	type RemoteServiceState,
	type RemoteState,
} from "./diff.js";
import {
	ErrorCode,
	PlatformError,
	PushAbortedError,
	PushConflictError,
} from "./errors.js";
import { buildFunctionBundle } from "./function-bundle.js";
import type { NeonApi, NeonBranchSnapshot } from "./neon-api.js";
import type { AppliedChange, Config, PushResult } from "./types.js";

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
	/**
	 * Inject a custom NeonApi adapter. Primarily used by tests; production callers can rely
	 * on the default real adapter built from `apiKey`.
	 */
	api?: NeonApi;
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
 * `options`. `pushConfig` performs no `.neon` lookups and reads no `NEON_*` env vars.
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
		exists: true,
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
	// Only fetch Preview state when the policy actually uses it — keeps pushes that don't
	// touch functions/buckets/aiGateway at the same number of API calls as before.
	if (resolved.preview) {
		remote.preview = await resolvePreviewState({
			api,
			projectId: remoteProject.id,
			branchId: branch.id,
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
				});
		applied.push(change);
	}

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
		step.kind === "update-endpoint"
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
			return {
				kind: "service",
				action: "create",
				identifier: "auth",
				details: {
					branchName: step.branchName,
					...(step.databaseName
						? { databaseName: step.databaseName }
						: {}),
				},
			};
		case "enable-data-api":
			return {
				kind: "service",
				action: "create",
				identifier: "dataApi",
				details: {
					branchName: step.branchName,
					databaseName: step.databaseName,
				},
			};
		case "create-bucket":
			return {
				kind: "service",
				action: "create",
				identifier: `bucket:${step.bucketName}`,
				details: {
					branchName: step.branchName,
					bucketName: step.bucketName,
					accessLevel: step.accessLevel,
				},
			};
		case "create-function":
			return {
				kind: "service",
				action: "create",
				identifier: `function:${step.fn.slug}`,
				details: {
					branchName: step.branchName,
					slug: step.fn.slug,
					name: step.fn.name,
				},
			};
		case "deploy-function":
			return {
				kind: "service",
				action: "update",
				identifier: `function:${step.fn.slug}`,
				details: {
					branchName: step.branchName,
					slug: step.fn.slug,
					source: step.fn.source,
					runtime: step.fn.runtime,
					memoryMib: step.fn.memoryMib,
					concurrency: step.fn.concurrency,
				},
			};
		case "enable-ai-gateway":
			return {
				kind: "service",
				action: "create",
				identifier: "aiGateway",
				details: { branchName: step.branchName },
			};
	}
}

function createApiFromOptions(options: PushConfigOptions): NeonApi {
	return createNeonApiFromOptions("pushConfig", {
		...(options.apiKey ? { apiKey: options.apiKey } : {}),
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
	return {
		databaseName,
		authEnabled: auth !== null,
		dataApiEnabled: dataApi !== null,
	};
}

/**
 * Pre-fetch the current state of branch-scoped Preview features (buckets, functions, AI
 * Gateway) so the diff can be computed additively. Only called when the policy has a
 * `preview` block.
 */
async function resolvePreviewState(args: {
	api: NeonApi;
	projectId: string;
	branchId: string;
}): Promise<RemotePreviewState> {
	const { api, projectId, branchId } = args;
	const [buckets, functions, aiGatewayEnabled] = await Promise.all([
		api.listBranchBuckets(projectId, branchId),
		api.listBranchFunctions(projectId, branchId),
		api.getAiGatewayEnabled(projectId, branchId),
	]);
	return { buckets, functions, aiGatewayEnabled };
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
				details: {
					branchName: step.branchName,
					...(step.databaseName
						? { databaseName: step.databaseName }
						: {}),
				},
			};
		}
		case "enable-data-api": {
			await ctx.api.enableProjectBranchDataApi(
				ctx.remoteProjectId,
				step.branchId,
				step.databaseName,
			);
			return {
				kind: "service",
				action: "create",
				identifier: "dataApi",
				details: {
					branchName: step.branchName,
					databaseName: step.databaseName,
				},
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
					branchName: step.branchName,
					bucketName: step.bucketName,
					accessLevel: step.accessLevel,
				},
			};
		}
		case "create-function": {
			await ctx.api.createBranchFunction(
				ctx.remoteProjectId,
				step.branchId,
				{ slug: step.fn.slug, name: step.fn.name },
			);
			return {
				kind: "service",
				action: "create",
				identifier: `function:${step.fn.slug}`,
				details: {
					branchName: step.branchName,
					slug: step.fn.slug,
					name: step.fn.name,
				},
			};
		}
		case "deploy-function": {
			const bundle = await buildFunctionBundle(step.fn);
			const deployment = await ctx.api.deployBranchFunction(
				ctx.remoteProjectId,
				step.branchId,
				step.fn.slug,
				{
					bundle,
					runtime: step.fn.runtime,
					memoryMib: step.fn.memoryMib,
					concurrency: step.fn.concurrency,
					environment: step.fn.env,
				},
			);
			return {
				kind: "service",
				action: "update",
				identifier: `function:${step.fn.slug}`,
				details: {
					branchName: step.branchName,
					slug: step.fn.slug,
					source: step.fn.source,
					runtime: step.fn.runtime,
					memoryMib: step.fn.memoryMib,
					concurrency: step.fn.concurrency,
					deploymentId: deployment.id,
				},
			};
		}
		case "enable-ai-gateway": {
			await ctx.api.enableAiGateway(ctx.remoteProjectId, step.branchId);
			return {
				kind: "service",
				action: "create",
				identifier: "aiGateway",
				details: { branchName: step.branchName },
			};
		}
	}
}
