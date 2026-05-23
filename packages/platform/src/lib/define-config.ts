import { parseDuration } from "./duration.js";
import { ConfigValidationError } from "./errors.js";
import { isWildcardPattern, validatePattern } from "./patterns.js";
import { configSchema, formatZodIssues } from "./schema.js";
import type {
	Config,
	ResolvedBranchBlueprint,
	ResolvedBranchConfig,
	ResolvedConfig,
} from "./types.js";

const DEFAULT_PARENT_KEY = "production";
const REGION_PREFIX = /^(aws|azure|gcp)-/;

/**
 * Validate and freeze a Neon Platform config using the zod {@link configSchema}.
 *
 * Used at the top of `neon.ts`:
 * ```ts
 * import { defineConfig } from "@neondatabase/platform/v1";
 *
 * export default defineConfig({
 *   project: { name: "my-app", region: "aws-us-east-1" },
 *   branches: {
 *     production: { protected: true, computeSettings: { autoscalingLimitMaxCu: 2 } },
 *     staging:    { parent: "production" },
 *   },
 *   branchBlueprints: {
 *     preview: { pattern: "preview-*", ttl: "1h", parent: "production" },
 *   },
 *   env: { databaseUrl: "POSTGRES_URL", databaseUrlUnpooled: "POSTGRES_URL_NON_POOLING" },
 * });
 * ```
 *
 * The `const` modifier preserves literal types from the input — so when `loadEnv(config)`
 * is called downstream, the return type knows exactly which env-var keys it will produce.
 *
 * Pure function — no I/O, no side effects. Aggregates every zod issue into one
 * {@link ConfigValidationError} so users see every issue at once.
 */
export function defineConfig<const C extends Config>(input: C): C {
	const result = configSchema.safeParse(input);
	if (!result.success) {
		throw new ConfigValidationError(formatZodIssues(result.error));
	}

	const parsed = result.data as Config;
	const frozen: Config = {
		project: Object.freeze({ ...parsed.project }),
	};
	if (parsed.branches) frozen.branches = freezeRecord(parsed.branches);
	if (parsed.branchBlueprints)
		frozen.branchBlueprints = freezeRecord(parsed.branchBlueprints);
	if (parsed.env) frozen.env = Object.freeze({ ...parsed.env });
	// The frozen copy has the same structural shape as `input`; cast to preserve the
	// caller-supplied literal types (env-var keys, branch keys, …) for downstream inference.
	return Object.freeze(frozen) as C;
}

function freezeRecord<T extends object>(
	record: Record<string, T> | undefined,
): Record<string, T> | undefined {
	if (!record) return undefined;
	return Object.freeze(
		Object.fromEntries(
			Object.entries(record).map(([k, v]) => [
				k,
				Object.freeze({ ...v }),
			]),
		),
	) as Record<string, T>;
}

/**
 * Resolve a `Config` (as produced by {@link defineConfig}) into flat lists of concrete
 * branches and blueprints with defaults applied (TTL parsed into seconds, default parents
 * filled in, etc.).
 *
 * Pure function. Throws {@link ConfigValidationError} if any cross-reference is invalid —
 * these are caught at `defineConfig` time too, but `resolveConfig` re-validates to make it
 * usable from `pullConfig` (which constructs a `Config` from remote state and skips
 * `defineConfig`).
 */
export function resolveConfig(config: Config): ResolvedConfig {
	const issues: string[] = [];

	const branchEntries = config.branches
		? Object.entries(config.branches)
		: [];
	const blueprintEntries = config.branchBlueprints
		? Object.entries(config.branchBlueprints)
		: [];
	const branchKeys = new Set(branchEntries.map(([k]) => k));

	const branches: ResolvedBranchConfig[] = [];
	for (const [key, branch] of branchEntries) {
		const parent = branch.parent;
		validateParent({
			parent,
			ownKey: key,
			branchKeys,
			label: `branches.${key}.parent`,
			issues,
		});
		branches.push({
			key,
			name: key,
			parent:
				parent ??
				(key === DEFAULT_PARENT_KEY ? undefined : DEFAULT_PARENT_KEY),
			protected: branch.protected === true,
			computeSettings: branch.computeSettings
				? { ...branch.computeSettings }
				: undefined,
		});
	}

	const blueprints: ResolvedBranchBlueprint[] = [];
	for (const [key, blueprint] of blueprintEntries) {
		let ttlSeconds: number | undefined;
		if (blueprint.ttl !== undefined) {
			const parsed = parseDuration(blueprint.ttl);
			if ("error" in parsed) {
				issues.push(`branchBlueprints.${key}.ttl: ${parsed.error}`);
			} else {
				ttlSeconds = parsed.seconds;
			}
		}

		const parent = blueprint.parent;
		validateParent({
			parent,
			ownKey: key,
			branchKeys,
			label: `branchBlueprints.${key}.parent`,
			issues,
		});

		blueprints.push({
			key,
			pattern: blueprint.pattern,
			ttlSeconds,
			parent:
				parent ??
				(key === DEFAULT_PARENT_KEY ? undefined : DEFAULT_PARENT_KEY),
			computeSettings: blueprint.computeSettings
				? { ...blueprint.computeSettings }
				: undefined,
		});
	}

	if (issues.length > 0) {
		throw new ConfigValidationError(issues);
	}

	return {
		project: { ...config.project },
		branches,
		branchBlueprints: blueprints,
	};
}

function validateParent(args: {
	parent: string | undefined;
	ownKey: string;
	branchKeys: Set<string>;
	label: string;
	issues: string[];
}): void {
	const { parent, ownKey, branchKeys, label, issues } = args;
	if (parent === undefined) return;
	if (parent === ownKey) return;
	if (branchKeys.has(parent)) return;
	const patternCheck = validatePattern(parent);
	if ("error" in patternCheck) {
		issues.push(
			`${label}: refers to "${parent}" which is neither another \`branches\` key nor a valid branch name (${patternCheck.error})`,
		);
	} else if (isWildcardPattern(parent)) {
		issues.push(
			`${label}: must be a concrete branch name (no wildcards), got "${parent}"`,
		);
	}
}

/**
 * Normalize a region identifier to Neon's `<cloud>-<region>` format. When the user writes
 * `us-east-1` we assume `aws-us-east-1`. Pure helper used by both the validator and the
 * NeonApi adapter.
 */
export function normalizeRegion(region: string): string {
	if (REGION_PREFIX.test(region)) return region;
	return `aws-${region}`;
}
