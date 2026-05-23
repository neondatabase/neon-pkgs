import { createNeonApiFromOptions } from "./auth.js";
import { defineConfig } from "./define-config.js";
import { loadContext } from "./load-context.js";
import type {
	NeonApi,
	NeonBranchSnapshot,
	NeonEndpointSnapshot,
	NeonProjectSnapshot,
} from "./neon-api.js";
import type { BranchConfig, ComputeSettings, Config } from "./types.js";

export interface PullConfigOptions {
	/** Neon API key. Falls back to `NEON_API_KEY`. Ignored when a custom `api` is supplied. */
	apiKey?: string;
	/** Explicit project id. Overrides the value read from `.neon/project.json` or `.neon`. */
	projectId?: string;
	/** Starting directory for the project-context search. Defaults to `process.cwd()`. */
	cwd?: string;
	/**
	 * Inject a custom NeonApi adapter. Primarily used by tests; production callers can rely
	 * on the default real adapter built from `apiKey`.
	 */
	api?: NeonApi;
}

/**
 * Pull the live Neon project state into a {@link Config} object. **Filesystem read-only**.
 *
 * Resolution rules:
 * 1. If `options.projectId` is set, it wins.
 * 2. Otherwise we walk up from `cwd` looking for `.neon/project.json` or `.neon`.
 * 3. If neither yields a project id, we throw {@link MissingContextError} — we never create
 *    a context file ourselves.
 *
 * The returned config is validated through `defineConfig` so it's safe to write to disk as
 * a `neon.ts` (out of scope for this package; do that from `neonctl`).
 */
export async function pullConfig(
	options: PullConfigOptions = {},
): Promise<Config> {
	const api = options.api ?? createApiFromOptions(options);
	const projectId = resolveProjectId(options);

	const project = await api.getProject(projectId);
	const branches = await api.listBranches(projectId);
	const endpoints = await api.listEndpoints(projectId);

	return defineConfig(buildConfigFromSnapshots(project, branches, endpoints));
}

function resolveProjectId(options: PullConfigOptions): string {
	const ctx = loadContext({
		...(options.projectId ? { projectId: options.projectId } : {}),
		...(options.cwd ? { cwd: options.cwd } : {}),
	});
	return ctx.projectId;
}

function createApiFromOptions(options: PullConfigOptions): NeonApi {
	return createNeonApiFromOptions("pullConfig", {
		...(options.apiKey ? { apiKey: options.apiKey } : {}),
	});
}

/**
 * Build a {@link Config} from a project snapshot + branches. Pure helper, exported so the
 * v1 e2e test can use it without re-importing internals.
 *
 * Only **concrete, persistent branches** make it into `config.branches` — ephemeral
 * branches (those with a future `expiresAt`) are dropped. Listing live branches at runtime
 * is `neonctl branches list`'s job, not config-as-code's. Likewise we don't try to round
 * trip a `branchBlueprints` section: blueprints are templates that live in your editable
 * `neon.ts`, not on Neon.
 */
export function buildConfigFromSnapshots(
	project: NeonProjectSnapshot,
	branches: NeonBranchSnapshot[],
	endpoints: NeonEndpointSnapshot[],
): Config {
	const endpointsByBranchId = new Map<string, NeonEndpointSnapshot>();
	for (const ep of endpoints) {
		if (ep.type === "read_write") endpointsByBranchId.set(ep.branchId, ep);
	}

	const persistent = branches.filter((b) => !isEphemeral(b));

	// Sort branches so the default branch comes first; this makes the emitted file stable.
	const sorted = [...persistent].sort((a, b) => {
		if (a.isDefault && !b.isDefault) return -1;
		if (!a.isDefault && b.isDefault) return 1;
		return a.name.localeCompare(b.name);
	});

	const branchById = new Map(branches.map((b) => [b.id, b] as const));
	const branchEntries: Record<string, BranchConfig> = {};
	const usedKeys = new Set<string>();

	for (const branch of sorted) {
		const key = pickBranchKey(branch.name, usedKeys);
		usedKeys.add(key);

		const entry: BranchConfig = {};

		const parent = branch.parentId
			? branchById.get(branch.parentId)
			: undefined;
		if (parent) {
			const defaultParentKey = "production";
			if (
				parent.name !== defaultParentKey ||
				branch.name === defaultParentKey
			) {
				entry.parent = parent.name;
			}
		}

		if (branch.protected) entry.protected = true;

		const endpoint = endpointsByBranchId.get(branch.id);
		if (endpoint) {
			const compute = endpointToComputeSettings(endpoint, project);
			if (compute) entry.computeSettings = compute;
		}

		branchEntries[key] = entry;
	}

	const config: Config = {
		project: {
			name: project.name,
			region: project.regionId,
			pgVersion: project.pgVersion,
		},
	};
	if (Object.keys(branchEntries).length > 0) config.branches = branchEntries;
	return config;
}

function isEphemeral(branch: NeonBranchSnapshot): boolean {
	if (!branch.expiresAt) return false;
	const expiresMs = Date.parse(branch.expiresAt);
	if (!Number.isFinite(expiresMs)) return false;
	return expiresMs > Date.now();
}

function pickBranchKey(branchName: string, used: Set<string>): string {
	// Concrete branch keys must equal the branch name on Neon (the key IS the name).
	// If a branch name contains characters that aren't legal in our config keys, the user
	// will see the validation error and decide whether to rename the branch on Neon —
	// we don't silently rewrite the key.
	if (!used.has(branchName)) return branchName;
	let i = 2;
	while (used.has(`${branchName}_${i}`)) i += 1;
	return `${branchName}_${i}`;
}

function endpointToComputeSettings(
	endpoint: NeonEndpointSnapshot,
	project: NeonProjectSnapshot,
): ComputeSettings | undefined {
	const defaults = project.defaultEndpointSettings;
	const out: ComputeSettings = {};
	if (
		endpoint.autoscalingLimitMinCu !== undefined &&
		endpoint.autoscalingLimitMinCu !== defaults?.autoscalingLimitMinCu
	) {
		out.autoscalingLimitMinCu = endpoint.autoscalingLimitMinCu;
	}
	if (
		endpoint.autoscalingLimitMaxCu !== undefined &&
		endpoint.autoscalingLimitMaxCu !== defaults?.autoscalingLimitMaxCu
	) {
		out.autoscalingLimitMaxCu = endpoint.autoscalingLimitMaxCu;
	}
	if (
		endpoint.suspendTimeout !== undefined &&
		endpoint.suspendTimeout !== defaults?.suspendTimeout
	) {
		out.suspendTimeout = endpoint.suspendTimeout;
	}
	return Object.keys(out).length > 0 ? out : undefined;
}
