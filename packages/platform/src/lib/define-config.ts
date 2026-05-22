import { parseDuration } from "./duration.js";
import { ConfigValidationError } from "./errors.js";
import { isWildcardPattern, validatePattern } from "./patterns.js";
import { configSchema, formatZodIssues } from "./schema.js";
import type {
	Config,
	ResolvedBranchBlueprint,
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
 *   branchBlueprints: {
 *     production: { computeSettings: { autoscalingLimitMaxCu: 2 } },
 *     preview:    { pattern: "preview-*", ttl: "1h", parent: "production" },
 *   },
 * });
 * ```
 *
 * Pure function — no I/O, no side effects. Aggregates every zod issue into one
 * {@link ConfigValidationError} so users see every issue at once.
 */
export function defineConfig(input: Config): Config {
	const result = configSchema.safeParse(input);
	if (!result.success) {
		throw new ConfigValidationError(formatZodIssues(result.error));
	}

	const parsed = result.data as Config;
	return Object.freeze({
		project: Object.freeze({ ...parsed.project }),
		branchBlueprints: parsed.branchBlueprints
			? Object.freeze(
					Object.fromEntries(
						Object.entries(parsed.branchBlueprints).map(
							([k, v]) => [k, Object.freeze({ ...v })],
						),
					),
				)
			: undefined,
	}) as Config;
}

/**
 * Resolve a `Config` (as produced by {@link defineConfig}) into a flat list of blueprints with
 * defaults applied (key copied into `pattern`, TTL parsed into seconds, etc.).
 *
 * Pure function. Throws {@link ConfigValidationError} if a blueprint has an unresolvable
 * parent or invalid TTL — these are caught at `defineConfig` time too, but `resolveConfig`
 * re-validates to make it usable from `pullConfig` (which constructs a `Config` from remote
 * state and skips `defineConfig`).
 */
export function resolveConfig(config: Config): ResolvedConfig {
	const issues: string[] = [];
	const blueprints: ResolvedBranchBlueprint[] = [];

	const entries = config.branchBlueprints
		? Object.entries(config.branchBlueprints)
		: [];
	const keys = new Set(entries.map(([k]) => k));

	for (const [key, blueprint] of entries) {
		const pattern = blueprint.pattern ?? key;
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
		if (parent !== undefined && parent !== key && !keys.has(parent)) {
			// Allow literal remote branch names (we cannot verify them without an API call).
			// We do flag it as an issue ONLY if it does not look like a valid branch name.
			const patternCheck = validatePattern(parent);
			if ("error" in patternCheck) {
				issues.push(
					`branchBlueprints.${key}.parent: refers to "${parent}" which is neither another blueprint key nor a valid branch name (${patternCheck.error})`,
				);
			} else if (isWildcardPattern(parent)) {
				issues.push(
					`branchBlueprints.${key}.parent: must be a concrete branch name (no wildcards), got "${parent}"`,
				);
			}
		}

		blueprints.push({
			key,
			pattern,
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
		branchBlueprints: blueprints,
	};
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
