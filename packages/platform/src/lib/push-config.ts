import { createNeonApiFromOptions } from "./auth.js";
import { resolveConfig } from "./define-config.js";
import {
	diffConfig,
	type PlanStep,
	type RemoteFeatureState,
	type RemoteState,
} from "./diff.js";
import {
	ErrorCode,
	MissingContextError,
	PlatformError,
	PushConflictError,
} from "./errors.js";
import { loadContext } from "./load-context.js";
import { loadConfigFromFile } from "./loader.js";
import type {
	CreateBranchInput,
	NeonApi,
	NeonBranchSnapshot,
	NeonProjectSnapshot,
} from "./neon-api.js";
import type {
	AppliedChange,
	Config,
	PushResult,
	ResolvedConfig,
} from "./types.js";

export interface PushConfigOptions {
	/** Neon API key. Falls back to `NEON_API_KEY`. Ignored when `api` is supplied. */
	apiKey?: string;
	/**
	 * Explicit project id. Overrides the value read from `.neon/project.json` / `.neon`
	 * and the `NEON_PROJECT_ID` env var.
	 *
	 * `pushConfig` **never creates a project** — it requires a resolvable project id from
	 * one of: this option, `NEON_PROJECT_ID`, or a `.neon[/project.json]` context file.
	 * If none is set, push throws `MissingContextError` and the message points the user at
	 * `npx neonctl link` to create/select a project and write local context.
	 */
	projectId?: string;
	/** Working directory for context / config file lookups. Defaults to `process.cwd()`. */
	cwd?: string;
	/**
	 * Inject a custom NeonApi adapter. Primarily used by tests; production callers can rely
	 * on the default real adapter built from `apiKey`.
	 */
	api?: NeonApi;
	/**
	 * When `true`, apply settings / `protected` / TTL drift on `config.branches` entries —
	 * and a project rename — as actual mutations instead of refusing with
	 * `PushConflictError`. Immutable project fields (`region`, `pgVersion`) always remain
	 * conflicts: no flag can patch them, the project would need to be recreated.
	 *
	 * Default: `false` (drift on existing entities → fail-fast conflict). Branch *creation*
	 * (adding a new entry to `config.branches`) is additive and runs regardless.
	 */
	updateExisting?: boolean;
	/**
	 * When `true`, compute the full plan against the live remote state but **do not
	 * execute any mutations**. The resulting `PushResult.applied` array records every
	 * change that *would* run on a real push (with the same action / identifier / details
	 * shape, so the existing CLI summary formatter just works), and conflicts are
	 * reported instead of thrown.
	 *
	 * Used by `neon-ts status` and any caller that wants a "would this push do
	 * something dangerous?" check before invoking `pushConfig` for real.
	 */
	dryRun?: boolean;
	/**
	 * Explicit path to a config file (only used when no `config` is supplied).
	 */
	configPath?: string;
}

/**
 * Push the local Neon configuration to the remote project.
 *
 * Overloads:
 *
 * 1. `pushConfig()` — auto-load `neon.ts` from the current working directory. Pulls the
 *    remote, diffs, and fails on conflict.
 * 2. `pushConfig(options)` — same as (1) but pass options like `updateExisting`, `apiKey`,
 *    `cwd`, `configPath`, etc.
 * 3. `pushConfig(config, options?)` — caller supplies an already-validated `Config` object.
 *    No filesystem reads (other than the project-context lookup, which can be bypassed by
 *    setting `projectId`).
 *
 * `pushConfig` requires a resolvable `projectId` (option / env / context file). It will
 * **not** create a project — bootstrap one with `npx neonctl link` first.
 */
export async function pushConfig(): Promise<PushResult>;
export async function pushConfig(
	options: PushConfigOptions,
): Promise<PushResult>;
export async function pushConfig(
	config: Config,
	options?: PushConfigOptions,
): Promise<PushResult>;
export async function pushConfig(
	arg1?: Config | PushConfigOptions,
	arg2?: PushConfigOptions,
): Promise<PushResult> {
	const { config: passedConfig, options } = splitArgs(arg1, arg2);

	const cwd = options.cwd ?? process.cwd();
	const projectId = requireProjectIdForPush(options, cwd);

	const api = options.api ?? createApiFromOptions(options);
	const config =
		passedConfig ??
		(await loadConfigFromFile({ path: options.configPath, cwd })).config;
	const resolved = resolveConfig(config);

	const dryRun = options.dryRun === true;
	const updateExisting = options.updateExisting === true;

	const remoteProject = await api.getProject(projectId);

	const [branches, endpoints] = await Promise.all([
		api.listBranches(remoteProject.id),
		api.listEndpoints(remoteProject.id),
	]);
	const features = await resolveFeatureState({
		api,
		resolved,
		project: remoteProject,
		branches,
	});
	const remote: RemoteState = { project: remoteProject, branches, endpoints };
	if (features) remote.features = features;

	const diff = diffConfig(resolved, remote, { updateExisting });

	if (!dryRun && diff.conflicts.length > 0) {
		throw new PushConflictError(diff.conflicts);
	}

	const applied: AppliedChange[] = [
		{ kind: "project", action: "noop", identifier: remoteProject.id },
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
		// `rename-project` is the only step that mutates the project record itself; once
		// it runs (or would-run in dry-run) the implicit noop entry above no longer
		// reflects reality, so swap it for the real change.
		if (change.kind === "project" && change.action === "update")
			applied[0] = change;
		else applied.push(change);
	}

	const result: PushResult = {
		projectId: remoteProject.id,
		dryRun,
		applied,
		conflicts: diff.conflicts,
	};
	if (remoteProject.orgId) result.orgId = remoteProject.orgId;
	return result;
}

/**
 * Build an {@link AppliedChange} from a {@link PlanStep} without calling the Neon API.
 * Used by dry-run mode so callers see the same record shape they would on a live push,
 * just with no side effects. Identifiers are the branch names from the plan; any
 * sub-resource ids (`branchId`, `endpointId`) flow through unchanged when known.
 */
function synthesizeAppliedChange(step: PlanStep): AppliedChange {
	switch (step.kind) {
		case "rename-project":
			return {
				kind: "project",
				action: "update",
				identifier: step.projectId,
				details: { from: step.fromName, to: step.toName },
			};
		case "create-branch":
			return {
				kind: "branch",
				action: "create",
				identifier: step.branchName,
				details: {
					parentBranchName: step.parentBranchName,
					...(step.expiresAt ? { expiresAt: step.expiresAt } : {}),
					...(step.protected ? { protected: true } : {}),
					...(step.computeSettings
						? { computeSettings: step.computeSettings }
						: {}),
				},
			};
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
				kind: "feature",
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
				kind: "feature",
				action: "create",
				identifier: "dataApi",
				details: {
					branchName: step.branchName,
					databaseName: step.databaseName,
				},
			};
	}
}

function splitArgs(
	arg1: Config | PushConfigOptions | undefined,
	arg2: PushConfigOptions | undefined,
): { config?: Config; options: PushConfigOptions } {
	if (arg1 === undefined) return { options: arg2 ?? {} };
	if (isConfigLike(arg1)) return { config: arg1, options: arg2 ?? {} };
	return { options: arg1 };
}

function isConfigLike(value: unknown): value is Config {
	if (value === null || typeof value !== "object") return false;
	const obj = value as Record<string, unknown>;
	if (obj.project === null || typeof obj.project !== "object") return false;
	const project = obj.project as Record<string, unknown>;
	return typeof project.name === "string";
}

function createApiFromOptions(options: PushConfigOptions): NeonApi {
	return createNeonApiFromOptions("pushConfig", {
		...(options.apiKey ? { apiKey: options.apiKey } : {}),
	});
}

function requireProjectIdForPush(
	options: PushConfigOptions,
	cwd: string,
): string {
	const projectId = resolveProjectId(options, cwd);
	if (!projectId) {
		throw new MissingContextError(
			[
				"pushConfig could not resolve a Neon project id.",
				"`pushConfig` does not create projects — run `npx neonctl link` first to create/select a project and write local context.",
				"Alternatively, pass `projectId` / `--project-id`, set `NEON_PROJECT_ID`, or commit a `.neon/project.json` context file.",
			].join("\n"),
		);
	}
	return projectId;
}

/**
 * Resolve a project id from the standard chain (options → env → `.neon[/project.json]`).
 * Returns `undefined` rather than throwing when nothing is set — the caller turns that
 * into a {@link MissingContextError} with the bootstrap hint.
 */
function resolveProjectId(
	options: PushConfigOptions,
	cwd: string,
): string | undefined {
	try {
		const ctx = loadContext({
			projectId: options.projectId,
			cwd,
		});
		return ctx.projectId;
	} catch (cause) {
		if (!(cause instanceof MissingContextError)) throw cause;
		return undefined;
	}
}

/**
 * Find the concrete branch that should govern the project's default branch — the entry
 * in `config.branches` with no `parent`. Used by feature targeting (the root branch is
 * where `features.auth` / `features.dataApi` integrations are enabled).
 */
function findRootBranch(config: ResolvedConfig) {
	const candidates = config.branches.filter((b) => b.parent === undefined);
	if (candidates.length > 0) return candidates[0];
	// Fallback: every entry has a parent (cycle / orphan). Pick the first so feature
	// targeting still has something to land on.
	return config.branches[0];
}

/**
 * Pre-fetch the current state of `config.features` integrations on the branch they should
 * target — typically the project's root concrete branch (the entry without `parent`),
 * falling back to whichever branch Neon has marked as default. Returns `undefined` when
 * `config.features` is empty / disabled, so push and diff stay free from extra work.
 *
 * Two read calls per enabled feature: `getNeonAuth` (when `features.auth`) and
 * `listBranchDatabases` + `getNeonDataApi` (when `features.dataApi`).
 */
async function resolveFeatureState(args: {
	api: NeonApi;
	resolved: ResolvedConfig;
	project: NeonProjectSnapshot;
	branches: NeonBranchSnapshot[];
}): Promise<RemoteFeatureState | undefined> {
	const { api, resolved, project, branches } = args;
	const features = resolved.features;
	if (!features) return undefined;
	if (features.auth !== true && features.dataApi !== true) return undefined;

	const targetBranch = findFeatureTargetBranch(resolved, branches);
	if (!targetBranch) return undefined;

	const databaseName = await pickFeatureDatabaseName(
		api,
		project.id,
		targetBranch.id,
	);

	const state: RemoteFeatureState = {
		branchId: targetBranch.id,
		branchName: targetBranch.name,
		databaseName,
		auth: null,
		dataApi: null,
	};

	const [auth, dataApi] = await Promise.all([
		features.auth === true
			? api.getNeonAuth(project.id, targetBranch.id)
			: Promise.resolve(null),
		features.dataApi === true
			? api.getNeonDataApi(project.id, targetBranch.id, databaseName)
			: Promise.resolve(null),
	]);
	state.auth = auth;
	state.dataApi = dataApi;
	return state;
}

/**
 * Pick the branch `config.features` integrations should attach to. The root concrete
 * branch (the one with no `parent`) wins because it's where `fetchEnv` reads by default;
 * if no concrete branch exists, fall back to whatever branch Neon has marked as default.
 */
function findFeatureTargetBranch(
	resolved: ResolvedConfig,
	branches: NeonBranchSnapshot[],
): NeonBranchSnapshot | undefined {
	const root = findRootBranch(resolved);
	if (root) {
		const match = branches.find((b) => b.name === root.name);
		if (match) return match;
	}
	return branches.find((b) => b.isDefault) ?? branches[0];
}

/**
 * Resolve the database name for a Data API integration. Auto-pick when the branch has
 * exactly one database; otherwise fall back to Neon's default (`neondb`) so the call
 * stays useful even on branches with multiple databases — push doesn't have a way to
 * surface a "pick one" prompt the way `fetchEnv` does.
 */
async function pickFeatureDatabaseName(
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
		case "rename-project": {
			const updated = await ctx.api.updateProject(step.projectId, {
				name: step.toName,
			});
			return {
				kind: "project",
				action: "update",
				identifier: updated.id,
				details: { from: step.fromName, to: updated.name },
			};
		}
		case "create-branch": {
			const parentBranch = ctx.branchByName.get(step.parentBranchName);
			if (!parentBranch && step.parentBranchName !== step.branchName) {
				throw new PlatformError(
					ErrorCode.MissingParentBranch,
					[
						`Cannot create branch '${step.branchName}': its parent '${step.parentBranchName}' does not exist on Neon.`,
						"Either define a blueprint for the parent so it gets created first, or change this blueprint's `parent` to an existing branch.",
					].join(" "),
				);
			}
			const createInput: CreateBranchInput = { name: step.branchName };
			if (parentBranch) createInput.parentId = parentBranch.id;
			else if (step.parentBranchId)
				createInput.parentId = step.parentBranchId;
			if (step.expiresAt) createInput.expiresAt = step.expiresAt;
			if (step.protected) createInput.protected = true;
			if (step.computeSettings)
				createInput.computeSettings = step.computeSettings;
			const result = await ctx.api.createBranch(
				ctx.remoteProjectId,
				createInput,
			);
			ctx.branchById.set(result.branch.id, result.branch);
			ctx.branchByName.set(result.branch.name, result.branch);
			return {
				kind: "branch",
				action: "create",
				identifier: result.branch.name,
				details: {
					branchId: result.branch.id,
					parentBranchName: step.parentBranchName,
				},
			};
		}
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
				kind: "feature",
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
				kind: "feature",
				action: "create",
				identifier: "dataApi",
				details: {
					branchName: step.branchName,
					databaseName: step.databaseName,
				},
			};
		}
	}
}
