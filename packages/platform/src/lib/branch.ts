import { createNeonApiFromOptions } from "./auth.js";
import * as branchName from "./branch-name.js";
import {
	applyContextFileFields,
	findContextFilePath,
	formatContextFile,
} from "./context-file.js";
import { resolveConfig } from "./define-config.js";
import { ErrorCode, PlatformError } from "./errors.js";
import { readCurrentGitBranch } from "./git.js";
import { loadContext } from "./load-context.js";
import { loadConfigFromFile } from "./loader.js";
import type {
	CreateBranchInput,
	NeonApi,
	NeonBranchSnapshot,
} from "./neon-api.js";
import type {
	ResolvedBranchBlueprint,
	ResolvedBranchConfig,
	ResolvedConfig,
} from "./types.js";

export interface BranchOptions {
	/**
	 * Name of the `branches` key to check out, or the `branchBlueprints` key to use as
	 * the creation template (e.g. `"production"` or `"preview"`).
	 */
	blueprint: string;
	/**
	 * Explicit project id. Overrides `NEON_PROJECT_ID` and `.neon[/project.json]`. When
	 * omitted, falls through the standard resolution chain (see {@link loadContext}).
	 */
	projectId?: string;
	/** Explicit org id. Overrides `NEON_ORG_ID` and the context file. */
	orgId?: string;
	/** Neon API key. Falls back to `NEON_API_KEY` and `~/.config/neonctl/credentials.json`. */
	apiKey?: string;
	/** Working directory for context / config / git lookups. Defaults to `process.cwd()`. */
	cwd?: string;
	/**
	 * Inject a custom NeonApi adapter. Primarily used by tests; production callers can rely
	 * on the default real adapter built from `apiKey`.
	 */
	api?: NeonApi;
	/** Explicit path to the `neon.ts` config file. Defaults to walking up from `cwd`. */
	configPath?: string;
	/**
	 * Override the git branch name. Pass `null` to skip the git lookup entirely (useful in
	 * CI where the actual git branch isn't meaningful). When omitted, the current branch is
	 * read from `git rev-parse --abbrev-ref HEAD` and normalized.
	 */
	gitBranch?: string | null;
	/**
	 * Maximum number of collision retries when generating a unique branch name.
	 * Default: 10.
	 */
	maxAttempts?: number;
}

/**
 * Shape of the JSON payload produced by `branch()` for `.neon/project.json`. Mirrors
 * {@link ContextFileFields} but tightens `branchId` to required — by the time `branch()`
 * returns, the new branch always exists.
 */
interface BranchContextData {
	projectId: string;
	orgId?: string;
	branchId: string;
}

/**
 * Outcome of the in-place context-file update performed by `branch()`.
 *
 * - `updated` — an existing `.neon/project.json` (or `.neon`) was rewritten with the new
 *   `branchId`.
 * - `no-file` — no context file existed; the caller can create one from `json` if they
 *   want subsequent commands to target the new branch by default.
 * - `write-failed` — a context file existed but writing failed (read-only filesystem,
 *   permission denied, …). The branch on Neon was still created; surface `error` and the
 *   `json` payload so the user can apply it by hand.
 */
export type BranchContextFile =
	| {
			status: "updated";
			path: string;
			json: string;
			data: BranchContextData;
	  }
	| {
			status: "no-file";
			json: string;
			data: BranchContextData;
	  }
	| {
			status: "write-failed";
			path: string;
			error: string;
			json: string;
			data: BranchContextData;
	  };

export interface BranchResult {
	/**
	 * `created` means a new ephemeral branch was minted from `branchBlueprints`.
	 * `checked-out` means the name matched a concrete entry in `branches` and the
	 * existing Neon branch was selected locally by updating the context file.
	 */
	action: "created" | "checked-out";
	projectId: string;
	orgId?: string;
	branchId: string;
	branchName: string;
	/** Concrete branch key that drove a checkout (for `branches.main`, this is `"main"`). */
	branchKey?: string;
	/** The blueprint key that drove creation (the value of `options.blueprint`). */
	blueprintKey?: string;
	/** The pattern from the blueprint (e.g. `"preview-*"`). */
	blueprintPattern?: string;
	/** Parent branch name on Neon. Present for newly-created branches. */
	parentBranchName?: string;
	/** Parent branch id on Neon. Present for newly-created branches. */
	parentBranchId?: string;
	/** Expiry timestamp applied from the blueprint's TTL, if any. */
	expiresAt?: string;
	/**
	 * Outcome of updating the project-context file with the new `branchId`. See
	 * {@link BranchContextFile} for the three possible states (updated / no-file /
	 * write-failed). The `json` and `data` fields are always populated regardless of
	 * status so the caller can fall back to applying the update by hand.
	 */
	contextFile: BranchContextFile;
}

/**
 * Create a new ephemeral branch from a blueprint, or check out a concrete branch listed
 * in `neon.ts`.
 *
 * Resolution & side-effects:
 * 1. Project context comes from (in order): `options.projectId` / `orgId` → env vars
 *    `NEON_PROJECT_ID` / `NEON_ORG_ID` → `.neon[/project.json]` walking up from `cwd`.
 *    Throws {@link MissingContextError} if no project id is resolvable.
 * 2. `neon.ts` is loaded via {@link loadConfigFromFile}. Throws {@link ConfigLoadError}
 *    if missing.
 * 3. If `options.blueprint` matches a concrete `branches` entry, the matching live Neon
 *    branch is checked out locally by writing its `branchId` to the context file. No
 *    branch is created. If the live branch does not exist yet, run `pushConfig` first.
 * 4. Otherwise the blueprint identified by `options.blueprint` must exist in
 *    `branchBlueprints` and have a wildcard pattern (e.g. `"preview-*"`).
 * 5. The branch name is composed as `<pattern with * replaced>` where the replacement is
 *    either `<normalized-git-branch>-<mini-id>` (when git is available and `gitBranch`
 *    wasn't explicitly set to `null`) or `<mini-id>` otherwise. Collisions with existing
 *    branches trigger a regeneration up to `maxAttempts` times.
 * 6. The branch is created on Neon (one `listBranches` call for context + parent lookup
 *    + collision detection, one `createBranch` mutation).
 * 7. When a context file already exists (`.neon/project.json` preferred, falling back to
 *    `.neon`), its `branchId` is updated in place so subsequent `fetchEnv` / `pullConfig`
 *    calls target the new branch. Other top-level keys are preserved. The write is
 *    attempted *safely* — a read-only filesystem or permission error is surfaced as
 *    `contextFile.status === "write-failed"` rather than crashing the call. New context
 *    files are *never* created; `result.contextFile.json` always holds the payload the
 *    caller can write themselves.
 */
export async function branch(options: BranchOptions): Promise<BranchResult> {
	const api = options.api ?? createApiFromOptions(options);
	const cwd = options.cwd ?? process.cwd();

	const ctx = loadContext({
		...(options.projectId ? { projectId: options.projectId } : {}),
		...(options.orgId ? { orgId: options.orgId } : {}),
		cwd,
	});

	const { config } = await loadConfigFromFile({
		...(options.configPath ? { path: options.configPath } : {}),
		cwd,
	});
	const resolved = resolveConfig(config);
	const branches = await api.listBranches(ctx.projectId);

	const concreteBranch = resolved.branches.find(
		(b) => b.key === options.blueprint,
	);
	if (concreteBranch) {
		return checkoutConcreteBranch({
			cwd,
			ctx,
			branch: concreteBranch,
			branches,
		});
	}

	const blueprint = resolved.branchBlueprints.find(
		(b) => b.key === options.blueprint,
	);
	if (!blueprint) {
		throw new PlatformError(
			ErrorCode.NotFound,
			[
				`branch: no branch or blueprint named "${options.blueprint}" in your neon.ts.`,
				`Available concrete branches: ${
					resolved.branches.length === 0
						? "(none — your config has no branches section)"
						: resolved.branches.map((b) => b.key).join(", ")
				}.`,
				`Available blueprints: ${
					resolved.branchBlueprints.length === 0
						? "(none — your config has no branchBlueprints section)"
						: resolved.branchBlueprints.map((b) => b.key).join(", ")
				}.`,
				"Either add it to `branches` to check out an existing branch, or add it to `branchBlueprints` to create a new ephemeral branch.",
			].join(" "),
			{
				details: {
					blueprint: options.blueprint,
					availableBranches: resolved.branches.map((b) => b.key),
					availableBlueprints: resolved.branchBlueprints.map(
						(b) => b.key,
					),
				},
			},
		);
	}

	const parentBranch = resolveParentBranch(blueprint, resolved, branches);

	const gitBranch = resolveGitBranch(options, cwd);
	const maxAttempts = options.maxAttempts ?? branchName.DEFAULT_MAX_ATTEMPTS;
	const generatedName = pickUniqueName({
		pattern: blueprint.pattern,
		...(gitBranch ? { gitBranch } : {}),
		existingNames: new Set(branches.map((b) => b.name)),
		maxAttempts,
	});

	const expiresAt =
		blueprint.ttlSeconds !== undefined
			? new Date(Date.now() + blueprint.ttlSeconds * 1000).toISOString()
			: undefined;
	const createInput: CreateBranchInput = {
		name: generatedName,
		parentId: parentBranch.id,
	};
	if (expiresAt) createInput.expiresAt = expiresAt;
	if (blueprint.computeSettings)
		createInput.computeSettings = blueprint.computeSettings;

	const created = await api.createBranch(ctx.projectId, createInput);

	const contextData: BranchContextData = {
		projectId: ctx.projectId,
		branchId: created.branch.id,
	};
	if (ctx.orgId) contextData.orgId = ctx.orgId;
	const contextJson = formatContextFile(contextData);
	const contextFile = applyToContextFile(cwd, contextData, contextJson);

	const result: BranchResult = {
		action: "created",
		projectId: ctx.projectId,
		branchId: created.branch.id,
		branchName: created.branch.name,
		blueprintKey: blueprint.key,
		blueprintPattern: blueprint.pattern,
		parentBranchName: parentBranch.name,
		parentBranchId: parentBranch.id,
		contextFile,
	};
	if (ctx.orgId) result.orgId = ctx.orgId;
	if (expiresAt) result.expiresAt = expiresAt;
	return result;
}

function checkoutConcreteBranch(args: {
	cwd: string;
	ctx: ReturnType<typeof loadContext>;
	branch: ResolvedBranchConfig;
	branches: NeonBranchSnapshot[];
}): BranchResult {
	const { cwd, ctx, branch, branches } = args;
	const remote = branches.find((b) => b.name === branch.name);
	if (!remote) {
		throw new PlatformError(
			ErrorCode.NotFound,
			[
				`branch: concrete branch "${branch.name}" is listed in neon.ts but does not exist on Neon.`,
				"Run `neon-ts push` first to create it, or choose an existing branch.",
			].join(" "),
			{
				details: {
					branchKey: branch.key,
					branchName: branch.name,
					availableBranches: branches.map((b) => b.name),
				},
			},
		);
	}

	const contextData: BranchContextData = {
		projectId: ctx.projectId,
		branchId: remote.id,
	};
	if (ctx.orgId) contextData.orgId = ctx.orgId;
	const contextJson = formatContextFile(contextData);
	const contextFile = applyToContextFile(cwd, contextData, contextJson);

	const result: BranchResult = {
		action: "checked-out",
		projectId: ctx.projectId,
		branchId: remote.id,
		branchName: remote.name,
		branchKey: branch.key,
		contextFile,
	};
	if (ctx.orgId) result.orgId = ctx.orgId;
	return result;
}

/**
 * Try to merge the new branch context into an existing `.neon/project.json` (or `.neon`)
 * file. Returns the right {@link BranchContextFile} variant for the outcome. Errors at the
 * filesystem layer (read-only mount, EACCES, …) are caught and surfaced as
 * `write-failed` rather than thrown — the branch creation succeeded on Neon and we don't
 * want the caller to think otherwise.
 */
function applyToContextFile(
	cwd: string,
	data: BranchContextData,
	json: string,
): BranchContextFile {
	const path = findContextFilePath(cwd);
	if (!path) return { status: "no-file", json, data };
	const outcome = applyContextFileFields(path, data);
	if (outcome.status === "updated")
		return { status: "updated", path, json, data };
	return {
		status: "write-failed",
		path,
		error: outcome.error,
		json,
		data,
	};
}

function createApiFromOptions(options: BranchOptions): NeonApi {
	return createNeonApiFromOptions(
		"branch",
		options.apiKey ? { apiKey: options.apiKey } : {},
	);
}

/**
 * Find the parent branch snapshot for `blueprint`, applying the same resolution rules as
 * `pushConfig`: blueprint `parent` keys are dereferenced through other blueprints first,
 * then matched against literal branch names on Neon. When the blueprint has no `parent`
 * we fall back to the project's default branch.
 */
function resolveParentBranch(
	blueprint: ResolvedBranchBlueprint,
	config: ResolvedConfig,
	branches: NeonBranchSnapshot[],
): NeonBranchSnapshot {
	const parentName = resolveParentBranchName(blueprint, config);
	if (parentName) {
		const found = branches.find((b) => b.name === parentName);
		if (found) return found;
		throw new PlatformError(
			ErrorCode.MissingParentBranch,
			[
				`branch: parent branch "${parentName}" required by blueprint "${blueprint.key}" does not exist on Neon.`,
				"Run `neon-ts push` first to create it, or change the blueprint's `parent` to an existing branch.",
			].join(" "),
			{
				details: {
					blueprint: blueprint.key,
					parent: parentName,
					availableBranches: branches.map((b) => b.name),
				},
			},
		);
	}

	const defaultBranch = branches.find((b) => b.isDefault) ?? branches[0];
	if (!defaultBranch) {
		throw new PlatformError(
			ErrorCode.MissingParentBranch,
			[
				`branch: project has no branches at all, so blueprint "${blueprint.key}" cannot pick a parent.`,
				"Run `neon-ts push` first to bootstrap the project's branches.",
			].join(" "),
			{ details: { blueprint: blueprint.key } },
		);
	}
	return defaultBranch;
}

function resolveParentBranchName(
	blueprint: ResolvedBranchBlueprint,
	config: ResolvedConfig,
): string | undefined {
	const parent = blueprint.parent;
	if (!parent) return undefined;
	const fromBranches = config.branches.find((b) => b.key === parent);
	if (fromBranches) return fromBranches.name;
	return parent;
}

function resolveGitBranch(
	options: BranchOptions,
	cwd: string,
): string | undefined {
	if (options.gitBranch === null) return undefined;
	const raw =
		options.gitBranch !== undefined
			? options.gitBranch
			: readCurrentGitBranch(cwd);
	if (!raw) return undefined;
	const normalized = branchName.normalizeGitBranch(raw);
	return normalized ?? undefined;
}

interface PickUniqueNameInput {
	pattern: string;
	gitBranch?: string;
	existingNames: Set<string>;
	maxAttempts: number;
}

function pickUniqueName(input: PickUniqueNameInput): string {
	for (let attempt = 0; attempt < input.maxAttempts; attempt++) {
		const candidate = branchName.buildBranchName({
			pattern: input.pattern,
			...(input.gitBranch ? { gitBranch: input.gitBranch } : {}),
			miniId: branchName.generateMiniId(),
		});
		if (!input.existingNames.has(candidate)) return candidate;
	}
	throw new PlatformError(
		ErrorCode.InternalError,
		[
			`branch: failed to generate a unique branch name after ${input.maxAttempts} attempts (pattern: ${input.pattern}).`,
			"This typically means too many branches already match the blueprint's pattern in the same namespace; consider tightening it or pruning old branches.",
		].join(" "),
		{
			details: {
				pattern: input.pattern,
				maxAttempts: input.maxAttempts,
			},
		},
	);
}
