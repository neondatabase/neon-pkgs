import { defineConfig } from "./define-config.js";
import { formatDurationSeconds } from "./duration.js";
import { ErrorCode, PlatformError } from "./errors.js";
import { loadContext } from "./load-context.js";
import type {
	NeonApi,
	NeonBranchSnapshot,
	NeonEndpointSnapshot,
	NeonProjectSnapshot,
} from "./neon-api.js";
import { createRealNeonApi } from "./neon-api-real.js";
import type { BranchBlueprint, ComputeSettings, Config } from "./types.js";

export interface PullConfigOptions {
	/** Neon API key. Falls back to `NEON_API_KEY`. Ignored when a custom `api` is supplied. */
	apiKey?: string;
	/** Explicit project id. Overrides the value read from `.neon/project.json` or `.neon`. */
	projectId?: string;
	/** Explicit org id. Currently unused for pull but accepted for parity with pushConfig. */
	orgId?: string;
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
		projectId: options.projectId,
		orgId: options.orgId,
		cwd: options.cwd,
	});
	return ctx.projectId;
}

function createApiFromOptions(options: PullConfigOptions): NeonApi {
	const apiKey = options.apiKey ?? process.env.NEON_API_KEY;
	if (!apiKey) {
		throw new PlatformError(
			ErrorCode.MissingApiKey,
			[
				"pullConfig has no Neon API key to work with.",
				"Either pass `apiKey` directly, set the NEON_API_KEY environment variable, or pass a custom `api` adapter (e.g. an in-memory fake for tests).",
				"Generate a key at https://console.neon.tech/app/settings/api-keys.",
			].join(" "),
		);
	}
	return createRealNeonApi({ apiKey });
}

/**
 * Build a {@link Config} from a project snapshot + branches. Pure helper, exported so the
 * v1 e2e test can use it without re-importing internals.
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

	const blueprints: Record<string, BranchBlueprint> = {};
	const usedKeys = new Set<string>();

	// Sort branches so the default branch comes first; this makes the emitted file stable.
	const sorted = [...branches].sort((a, b) => {
		if (a.isDefault && !b.isDefault) return -1;
		if (!a.isDefault && b.isDefault) return 1;
		return a.name.localeCompare(b.name);
	});

	const branchById = new Map(branches.map((b) => [b.id, b] as const));

	for (const branch of sorted) {
		const key = pickBlueprintKey(branch.name, usedKeys);
		usedKeys.add(key);

		const blueprint: BranchBlueprint = {};
		if (key !== branch.name) blueprint.pattern = branch.name;

		const parent = branch.parentId
			? branchById.get(branch.parentId)
			: undefined;
		if (parent) {
			const defaultParentKey = "production";
			if (
				parent.name !== defaultParentKey ||
				branch.name === defaultParentKey
			) {
				blueprint.parent = parent.name;
			}
		}

		if (branch.expiresAt) {
			const ms = Date.parse(branch.expiresAt) - Date.now();
			if (Number.isFinite(ms) && ms > 0) {
				const ttlSeconds = Math.max(1, Math.round(ms / 1000));
				blueprint.ttl = formatDurationSeconds(ttlSeconds);
			}
		}

		const endpoint = endpointsByBranchId.get(branch.id);
		if (endpoint) {
			const compute = endpointToComputeSettings(endpoint, project);
			if (compute) blueprint.computeSettings = compute;
		}

		blueprints[key] = blueprint;
	}

	const config: Config = {
		project: {
			name: project.name,
			region: project.regionId,
			pgVersion: project.pgVersion,
		},
	};
	if (Object.keys(blueprints).length > 0)
		config.branchBlueprints = blueprints;
	return config;
}

function pickBlueprintKey(branchName: string, used: Set<string>): string {
	const normalized = sanitizeKey(branchName);
	if (!used.has(normalized)) return normalized;
	let i = 2;
	while (used.has(`${normalized}_${i}`)) i += 1;
	return `${normalized}_${i}`;
}

function sanitizeKey(branchName: string): string {
	const replaced = branchName.replace(/[^A-Za-z0-9_]/g, "_");
	if (replaced === "" || /^[0-9]/.test(replaced)) return `branch_${replaced}`;
	return replaced;
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
		endpoint.suspendTimeoutSeconds !== undefined &&
		endpoint.suspendTimeoutSeconds !== defaults?.suspendTimeoutSeconds
	) {
		out.suspendTimeoutSeconds = endpoint.suspendTimeoutSeconds;
	}
	return Object.keys(out).length > 0 ? out : undefined;
}
