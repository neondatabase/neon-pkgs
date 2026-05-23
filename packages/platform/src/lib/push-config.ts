import { createNeonApiFromOptions } from "./auth.js";
import { normalizeRegion, resolveConfig } from "./define-config.js";
import { diffConfig, type PlanStep, type RemoteState } from "./diff.js";
import {
	bugReportFooter,
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
	 * Explicit project id. Overrides the value read from `.neon/project.json` or `.neon`.
	 *
	 * On a brand-new project (no remote project yet) leave this unset; the push will
	 * look for a project named `config.project.name` in the supplied org, and create one
	 * if none is found.
	 */
	projectId?: string;
	/** Explicit org id. Required when creating a new project unless a context file supplies one. */
	orgId?: string;
	/** Working directory for context / config file lookups. Defaults to `process.cwd()`. */
	cwd?: string;
	/**
	 * Inject a custom NeonApi adapter. Primarily used by tests; production callers can rely
	 * on the default real adapter built from `apiKey`.
	 */
	api?: NeonApi;
	/**
	 * When `false` (the default): push pulls the remote, diffs against local, and refuses
	 * to apply if there are conflicts. Specifically: branch creation (additive) always runs,
	 * but settings/TTL updates on existing branches require `updateExisting: true`, and
	 * project-level conflicts (region, pgVersion, name) are surfaced.
	 *
	 * When `true`: any field-level conflict is treated as "apply anyway". Combined with
	 * `updateExisting: true` to actually rewrite existing branch settings.
	 */
	applyChanges?: boolean;
	/**
	 * When `true`, update existing specific-name branches whose settings/TTL drifted from
	 * the local config. When `false` (default), report them as conflicts.
	 *
	 * Implies `applyChanges: true` for those branches (we still surface project-level
	 * conflicts separately).
	 */
	updateExisting?: boolean;
	/**
	 * When `true`, apply wildcard-blueprint settings/TTL to every matching existing branch.
	 * When `false` (default), matched branches are reported under
	 * `PushResult.skippedWildcardBranches` and no mutations occur.
	 */
	applyExisting?: boolean;
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
 * 2. `pushConfig(options)` — same as (1) but pass options like `applyChanges`, `apiKey`,
 *    `cwd`, `configPath`, etc.
 * 3. `pushConfig(config, options?)` — caller supplies an already-validated `Config` object.
 *    No filesystem reads (other than the project-context lookup, which can be bypassed by
 *    setting `projectId`/`orgId`).
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

	const api = options.api ?? createApiFromOptions(options);
	const cwd = options.cwd ?? process.cwd();

	const config =
		passedConfig ??
		(await loadConfigFromFile({ path: options.configPath, cwd })).config;
	const resolved = resolveConfig(config);

	const { project: remoteProject, projectCreated } =
		await resolveOrCreateProject(api, resolved, options, cwd);

	const branches = await api.listBranches(remoteProject.id);
	const endpoints = await api.listEndpoints(remoteProject.id);
	const remote: RemoteState = { project: remoteProject, branches, endpoints };

	const updateExisting =
		options.updateExisting === true || options.applyChanges === true;
	const applyExisting = options.applyExisting === true;
	const diff = diffConfig(resolved, remote, {
		updateExisting,
		applyExisting,
	});

	if (diff.conflicts.length > 0 && options.applyChanges !== true) {
		throw new PushConflictError(diff.conflicts);
	}

	const applied: AppliedChange[] = [];

	if (projectCreated) {
		applied.push({
			kind: "project",
			action: "create",
			identifier: remoteProject.id,
			details: {
				name: remoteProject.name,
				regionId: remoteProject.regionId,
			},
		});
	} else if (
		resolved.project.name !== remoteProject.name &&
		options.applyChanges === true
	) {
		const updated = await api.updateProject(remoteProject.id, {
			name: resolved.project.name,
		});
		applied.push({
			kind: "project",
			action: "update",
			identifier: updated.id,
			details: { from: remoteProject.name, to: updated.name },
		});
	} else {
		applied.push({
			kind: "project",
			action: "noop",
			identifier: remoteProject.id,
		});
	}

	const branchById = new Map(branches.map((b) => [b.id, b] as const));
	const branchByName = new Map(branches.map((b) => [b.name, b] as const));

	for (const step of diff.plan) {
		const change = await applyStep(step, {
			api,
			remoteProjectId: remoteProject.id,
			branchById,
			branchByName,
		});
		applied.push(change);
	}

	const result: PushResult = {
		projectId: remoteProject.id,
		applied,
		conflicts: diff.conflicts,
		skippedWildcardBranches: diff.skippedWildcardBranches,
	};
	if (remoteProject.orgId) result.orgId = remoteProject.orgId;
	return result;
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

interface ResolvedProjectResult {
	project: NeonProjectSnapshot;
	projectCreated: boolean;
}

async function resolveOrCreateProject(
	api: NeonApi,
	config: ResolvedConfig,
	options: PushConfigOptions,
	cwd: string,
): Promise<ResolvedProjectResult> {
	let projectId: string | undefined;
	let orgId: string | undefined;
	try {
		const ctx = loadContext({
			projectId: options.projectId,
			orgId: options.orgId,
			cwd,
		});
		projectId = ctx.projectId;
		orgId = ctx.orgId;
	} catch (cause) {
		if (!(cause instanceof MissingContextError)) throw cause;
		orgId = options.orgId ?? process.env.NEON_ORG_ID;
	}

	if (projectId) {
		const project = await api.getProject(projectId);
		return { project, projectCreated: false };
	}

	// No explicit project id. Look for a project matching `config.project.name`. When
	// `orgId` is undefined we rely on the API key's implicit scope (org-scoped keys see
	// only their own org's projects; user-scoped keys see every project the user can
	// access — duplicate-name detection below catches the ambiguous case).
	//
	// Project-scoped API keys cannot list projects at all; surface that as a clear
	// `PLATFORM_INSUFFICIENT_SCOPE` error so the user knows they need to pass `projectId`
	// (or move to an org/user-scoped key). The adapter wraps the underlying 401/403 into a
	// PlatformError already; we additionally rewrite it here because the listProjects
	// failure is specifically about scope, not about a wrong endpoint.
	let projects: Awaited<ReturnType<NeonApi["listProjects"]>>;
	try {
		projects = await api.listProjects(orgId ? { orgId } : {});
	} catch (err) {
		if (isLikelyScopeError(err)) {
			throw new PlatformError(
				ErrorCode.InsufficientScope,
				[
					"pushConfig could not list Neon projects with this API key.",
					"This is expected for **project-scoped** keys, which can only operate on their own project.",
					"Resolutions:",
					"  - Pass `projectId` (SDK) / `--project-id` (CLI), or",
					"  - Set `NEON_PROJECT_ID` in the environment, or",
					"  - Commit a `.neon/project.json` (or `.neon`) with a `projectId` field, or",
					"  - Switch to an organisation- or user-scoped API key.",
				].join("\n"),
				{ cause: err },
			);
		}
		throw err;
	}
	const matches = projects.filter((p) => p.name === config.project.name);
	if (matches.length > 1) {
		throw new PlatformError(
			ErrorCode.AmbiguousProject,
			[
				`Multiple Neon projects${orgId ? ` in org ${orgId}` : ""} are named "${config.project.name}":`,
				...matches.map((p) => `  - ${p.id} (region ${p.regionId})`),
				"Pass an explicit `projectId` (SDK), `--project-id` (CLI), or set `NEON_PROJECT_ID` to pick one.",
			].join("\n"),
			{
				details: {
					name: config.project.name,
					candidateProjectIds: matches.map((p) => p.id),
				},
			},
		);
	}
	if (matches.length === 1) {
		return { project: matches[0], projectCreated: false };
	}

	if (!config.project.region) {
		throw new PlatformError(
			ErrorCode.RegionRequired,
			[
				`No remote project named "${config.project.name}" exists${orgId ? ` in org ${orgId}` : ""}.`,
				'Add a `region` to your config\'s `project` section so push can create the project on first run. Example: `region: "aws-us-east-1"`. See https://neon.com/docs/introduction/regions for valid identifiers.',
			].join(" "),
		);
	}

	// On first-time create, name the project's auto-created default branch after the
	// root branch (e.g. `production`) so the diff matches without trying to create a
	// sibling. Likewise seed the project's default endpoint settings from that branch so
	// the auto-created endpoint matches the desired compute settings on the very first
	// push, no `updateExisting` flag needed.
	const root = findRootBranch(config);
	const created = await api.createProject({
		name: config.project.name,
		regionId: normalizeRegion(config.project.region),
		pgVersion: config.project.pgVersion,
		...(orgId ? { orgId } : {}),
		...(root?.computeSettings
			? { defaultEndpointSettings: root.computeSettings }
			: {}),
		...(root ? { defaultBranchName: root.name } : {}),
	});
	return { project: created, projectCreated: true };
}

function isLikelyScopeError(err: unknown): boolean {
	if (err instanceof PlatformError) {
		if (
			err.code === ErrorCode.Unauthorized ||
			err.code === ErrorCode.Forbidden
		)
			return true;
	}
	// Fall back to the raw HTTP status in case a custom adapter doesn't go through the
	// wrapping layer.
	if (err !== null && typeof err === "object") {
		const response = (err as { response?: unknown }).response;
		if (response !== null && typeof response === "object") {
			const status = (response as { status?: unknown }).status;
			if (status === 401 || status === 403) return true;
		}
	}
	return false;
}

/**
 * Find the concrete branch that should govern the project's default branch on first-time
 * creation. The "root" branch is the entry in `config.branches` with no parent — the top
 * of the branch tree. Users can rename it by setting `parent` on the others.
 */
function findRootBranch(config: ResolvedConfig) {
	const candidates = config.branches.filter((b) => b.parent === undefined);
	if (candidates.length > 0) return candidates[0];
	// Fallback: every entry has a parent (cycle / orphan). Pick the first so the
	// auto-created default branch at least has a useful name.
	return config.branches[0];
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
		case "create-project":
		case "update-project": {
			throw new PlatformError(
				ErrorCode.InternalError,
				`Plan step '${step.kind}' should never reach the executor — pushConfig handles project mutations directly.${bugReportFooter()}`,
			);
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
	}
}
