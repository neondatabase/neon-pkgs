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
import type { NeonApi, NeonBranchSnapshot } from "./neon-api.js";
import type { Config, ResolvedBranchConfig } from "./types.js";

export interface BranchOptions {
	name: string;
	projectId?: string;
	orgId?: string;
	apiKey?: string;
	cwd?: string;
	api?: NeonApi;
	configPath?: string;
	gitBranch?: string | null;
	maxAttempts?: number;
}

interface BranchContextData {
	projectId: string;
	orgId?: string;
	branchId: string;
}

export type BranchContextFile =
	| { status: "updated"; path: string; json: string; data: BranchContextData }
	| { status: "no-file"; json: string; data: BranchContextData }
	| {
			status: "write-failed";
			path: string;
			error: string;
			json: string;
			data: BranchContextData;
	  };

export interface BranchResult {
	projectId: string;
	orgId?: string;
	branchId: string;
	branchName: string;
	pattern: string;
	parentBranchName: string;
	parentBranchId: string;
	expiresAt?: string;
	contextFile: BranchContextFile;
}

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
	return createBranchFromPolicy({ options, cwd, ctx, config, api });
}

async function createBranchFromPolicy(args: {
	options: BranchOptions;
	cwd: string;
	ctx: ReturnType<typeof loadContext>;
	config: Config;
	api: NeonApi;
}): Promise<BranchResult> {
	const { options, cwd, ctx, config, api } = args;
	const branches = await api.listBranches(ctx.projectId);
	const pattern = normalizeCreatePattern(options.name);
	const gitBranch = resolveGitBranch(options, cwd);
	const branchNameToCreate = pickUniqueName({
		pattern,
		...(gitBranch ? { gitBranch } : {}),
		existingNames: new Set(branches.map((b) => b.name)),
		maxAttempts: options.maxAttempts ?? branchName.DEFAULT_MAX_ATTEMPTS,
	});
	const desired = resolveConfig(config, {
		name: branchNameToCreate,
		exists: false,
	});
	const parentBranch = resolveParentBranch(desired, branches);
	const expiresAt =
		desired.ttlSeconds !== undefined
			? new Date(Date.now() + desired.ttlSeconds * 1000).toISOString()
			: undefined;
	const createInput = {
		name: branchNameToCreate,
		parentId: parentBranch.id,
		...(expiresAt ? { expiresAt } : {}),
		...(desired.protected !== undefined
			? { protected: desired.protected }
			: {}),
		...(desired.postgres?.computeSettings
			? { computeSettings: desired.postgres.computeSettings }
			: {}),
	};
	const created = await api.createBranch(ctx.projectId, createInput);
	await applyBranchFeatures({
		api,
		projectId: ctx.projectId,
		branchId: created.branch.id,
		desired,
	});
	const contextData: BranchContextData = {
		projectId: ctx.projectId,
		branchId: created.branch.id,
	};
	if (ctx.orgId) contextData.orgId = ctx.orgId;
	const contextJson = formatContextFile(contextData);
	const contextFile = applyToContextFile(cwd, contextData, contextJson);
	const result: BranchResult = {
		projectId: ctx.projectId,
		branchId: created.branch.id,
		branchName: created.branch.name,
		pattern,
		parentBranchName: parentBranch.name,
		parentBranchId: parentBranch.id,
		contextFile,
	};
	if (ctx.orgId) result.orgId = ctx.orgId;
	if (expiresAt) result.expiresAt = expiresAt;
	return result;
}

async function applyBranchFeatures(args: {
	api: NeonApi;
	projectId: string;
	branchId: string;
	desired: ResolvedBranchConfig;
}): Promise<void> {
	const { api, projectId, branchId, desired } = args;
	if (!desired.authEnabled && !desired.dataApiEnabled) return;
	const databaseName = await pickFeatureDatabaseName(
		api,
		projectId,
		branchId,
	);
	await Promise.all([
		desired.authEnabled
			? api.enableNeonAuth(projectId, branchId, { databaseName })
			: Promise.resolve(),
		desired.dataApiEnabled
			? api.enableProjectBranchDataApi(projectId, branchId, databaseName)
			: Promise.resolve(),
	]);
}

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

function resolveParentBranch(
	desired: ResolvedBranchConfig,
	branches: NeonBranchSnapshot[],
): NeonBranchSnapshot {
	if (desired.parent) {
		const found = branches.find((b) => b.name === desired.parent);
		if (found) return found;
		throw new PlatformError(
			ErrorCode.MissingParentBranch,
			[
				`branch: parent branch "${desired.parent}" does not exist on Neon.`,
				"Change the branch policy's `parent` or create/check out a branch from an existing parent.",
			].join(" "),
			{
				details: {
					parent: desired.parent,
					availableBranches: branches.map((b) => b.name),
				},
			},
		);
	}
	const defaultBranch = branches.find((b) => b.isDefault) ?? branches[0];
	if (!defaultBranch) {
		throw new PlatformError(
			ErrorCode.MissingParentBranch,
			"branch: project has no branches, so a new branch cannot pick a parent.",
		);
	}
	return defaultBranch;
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

function normalizeCreatePattern(input: string): string {
	return input.includes("*") ? input : `${input}-*`;
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
			"This typically means too many branches already match the pattern in the same namespace; consider tightening it or pruning old branches.",
		].join(" "),
		{
			details: {
				pattern: input.pattern,
				maxAttempts: input.maxAttempts,
			},
		},
	);
}
