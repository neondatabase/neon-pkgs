import { createNeonApiFromOptions } from "./auth.js";
import {
	applyContextFileFields,
	findContextFilePath,
	formatContextFile,
} from "./context-file.js";
import { ErrorCode, PlatformError } from "./errors.js";
import { loadContext } from "./load-context.js";
import type { NeonApi } from "./neon-api.js";

export interface CheckoutOptions {
	branch: string;
	projectId?: string;
	orgId?: string;
	apiKey?: string;
	cwd?: string;
	api?: NeonApi;
}

interface CheckoutContextData {
	projectId: string;
	orgId?: string;
	branchId: string;
}

export type CheckoutContextFile =
	| {
			status: "updated";
			path: string;
			json: string;
			data: CheckoutContextData;
	  }
	| {
			status: "no-file";
			json: string;
			data: CheckoutContextData;
	  }
	| {
			status: "write-failed";
			path: string;
			error: string;
			json: string;
			data: CheckoutContextData;
	  };

export interface CheckoutResult {
	projectId: string;
	orgId?: string;
	branchId: string;
	branchName: string;
	contextFile: CheckoutContextFile;
}

export async function checkout(
	options: CheckoutOptions,
): Promise<CheckoutResult> {
	const api = options.api ?? createApiFromOptions(options);
	const cwd = options.cwd ?? process.cwd();
	const ctx = loadContext({
		...(options.projectId ? { projectId: options.projectId } : {}),
		...(options.orgId ? { orgId: options.orgId } : {}),
		cwd,
	});
	const branches = await api.listBranches(ctx.projectId);
	const branch = branches.find(
		(b) => b.id === options.branch || b.name === options.branch,
	);
	if (!branch) {
		throw new PlatformError(
			ErrorCode.BranchNotFound,
			[
				`checkout: branch "${options.branch}" was not found on project ${ctx.projectId}.`,
				`Available branches: ${branches.map((b) => `${b.name} (${b.id})`).join(", ") || "(none)"}.`,
			].join(" "),
			{
				details: {
					projectId: ctx.projectId,
					branch: options.branch,
					availableBranches: branches.map((b) => b.name),
				},
			},
		);
	}
	const data: CheckoutContextData = {
		projectId: ctx.projectId,
		branchId: branch.id,
	};
	if (ctx.orgId) data.orgId = ctx.orgId;
	const json = formatContextFile(data);
	const contextFile = applyToContextFile(cwd, data, json);
	const result: CheckoutResult = {
		projectId: ctx.projectId,
		branchId: branch.id,
		branchName: branch.name,
		contextFile,
	};
	if (ctx.orgId) result.orgId = ctx.orgId;
	return result;
}

function createApiFromOptions(options: CheckoutOptions): NeonApi {
	return createNeonApiFromOptions(
		"checkout",
		options.apiKey ? { apiKey: options.apiKey } : {},
	);
}

function applyToContextFile(
	cwd: string,
	data: CheckoutContextData,
	json: string,
): CheckoutContextFile {
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
