import { parseDuration } from "./duration.js";
import { ConfigValidationError } from "./errors.js";
import { isWildcardPattern, validatePattern } from "./patterns.js";
import type {
	Config,
	ResolvedBranchBlueprint,
	ResolvedConfig,
} from "./types.js";

const DEFAULT_PARENT_KEY = "production";
const REGION_PREFIX = /^(aws|azure|gcp)-/;

/**
 * Validate and freeze a Neon Platform config.
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
 * Pure function — no I/O, no side effects. Throws {@link ConfigValidationError} for any
 * structural problem so the user sees every issue at once.
 */
export function defineConfig(input: Config): Config {
	const issues: string[] = [];

	if (input === null || typeof input !== "object") {
		throw new ConfigValidationError(["config must be an object"]);
	}

	if (input.project === null || typeof input.project !== "object") {
		issues.push("project is required and must be an object");
	} else {
		validateProject(input.project, issues);
	}

	const blueprintsRaw = input.branchBlueprints;
	if (blueprintsRaw !== undefined) {
		if (
			blueprintsRaw === null ||
			typeof blueprintsRaw !== "object" ||
			Array.isArray(blueprintsRaw)
		) {
			issues.push("branchBlueprints must be a plain object");
		} else {
			for (const [key, blueprint] of Object.entries(blueprintsRaw)) {
				validateBlueprint(key, blueprint, blueprintsRaw, issues);
			}
		}
	}

	if (issues.length > 0) {
		throw new ConfigValidationError(issues);
	}

	const frozen: Config = Object.freeze({
		project: Object.freeze({ ...input.project }),
		branchBlueprints: blueprintsRaw
			? Object.freeze(
					Object.fromEntries(
						Object.entries(blueprintsRaw).map(([k, v]) => [
							k,
							Object.freeze({ ...v }),
						]),
					),
				)
			: undefined,
	}) as Config;

	return frozen;
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

function validateProject(project: unknown, issues: string[]): void {
	const p = project as Record<string, unknown>;

	if (typeof p.name !== "string") {
		issues.push("project.name is required and must be a string");
	} else {
		const name = p.name.trim();
		if (name === "") issues.push("project.name must not be empty");
		else if (name.length > 256)
			issues.push("project.name must be <= 256 characters");
		else if (name !== p.name)
			issues.push("project.name has leading or trailing whitespace");
	}

	if (p.region !== undefined) {
		if (typeof p.region !== "string") {
			issues.push("project.region must be a string when set");
		} else if (p.region.trim() === "") {
			issues.push("project.region must not be empty when set");
		} else if (!/^[a-z0-9-]+$/.test(p.region)) {
			issues.push(
				`project.region must be lowercase letters, digits, and '-' (got ${JSON.stringify(p.region)})`,
			);
		}
	}

	if (p.pgVersion !== undefined) {
		if (typeof p.pgVersion !== "number" || !Number.isInteger(p.pgVersion)) {
			issues.push("project.pgVersion must be an integer");
		} else if (p.pgVersion < 14 || p.pgVersion > 18) {
			issues.push(
				`project.pgVersion must be between 14 and 18 (got ${p.pgVersion})`,
			);
		}
	}

	for (const key of Object.keys(p)) {
		if (key !== "name" && key !== "region" && key !== "pgVersion") {
			issues.push(`project has unknown key: ${JSON.stringify(key)}`);
		}
	}
}

function validateBlueprint(
	key: string,
	blueprint: unknown,
	allBlueprints: Record<string, unknown>,
	issues: string[],
): void {
	if (
		blueprint === null ||
		typeof blueprint !== "object" ||
		Array.isArray(blueprint)
	) {
		issues.push(`branchBlueprints.${key} must be an object`);
		return;
	}

	const b = blueprint as Record<string, unknown>;
	const pattern = (b.pattern as string | undefined) ?? key;

	if (b.pattern !== undefined && typeof b.pattern !== "string") {
		issues.push(
			`branchBlueprints.${key}.pattern must be a string when set`,
		);
	} else {
		const v = validatePattern(pattern);
		if ("error" in v)
			issues.push(`branchBlueprints.${key}.pattern: ${v.error}`);
	}

	if (b.ttl !== undefined) {
		if (typeof b.ttl !== "string" && typeof b.ttl !== "number") {
			issues.push(
				`branchBlueprints.${key}.ttl must be a string or number`,
			);
		} else {
			const parsed = parseDuration(b.ttl);
			if ("error" in parsed)
				issues.push(`branchBlueprints.${key}.ttl: ${parsed.error}`);
		}
	}

	if (b.parent !== undefined) {
		if (typeof b.parent !== "string") {
			issues.push(`branchBlueprints.${key}.parent must be a string`);
		} else if (b.parent === key) {
			issues.push(
				`branchBlueprints.${key}.parent must not reference itself`,
			);
		} else if (!(b.parent in allBlueprints)) {
			const v = validatePattern(b.parent);
			if ("error" in v) {
				issues.push(`branchBlueprints.${key}.parent: ${v.error}`);
			} else if (isWildcardPattern(b.parent)) {
				issues.push(
					`branchBlueprints.${key}.parent must be a concrete branch name (no wildcards), got "${b.parent}"`,
				);
			}
		}
	}

	if (b.computeSettings !== undefined) {
		validateComputeSettings(key, b.computeSettings, issues);
	}

	for (const k of Object.keys(b)) {
		if (
			k !== "pattern" &&
			k !== "ttl" &&
			k !== "parent" &&
			k !== "computeSettings"
		) {
			issues.push(
				`branchBlueprints.${key} has unknown key: ${JSON.stringify(k)}`,
			);
		}
	}
}

function validateComputeSettings(
	blueprintKey: string,
	settings: unknown,
	issues: string[],
): void {
	if (
		settings === null ||
		typeof settings !== "object" ||
		Array.isArray(settings)
	) {
		issues.push(
			`branchBlueprints.${blueprintKey}.computeSettings must be an object`,
		);
		return;
	}
	const s = settings as Record<string, unknown>;

	const min = s.autoscalingLimitMinCu;
	const max = s.autoscalingLimitMaxCu;
	const suspend = s.suspendTimeoutSeconds;

	if (min !== undefined) {
		if (typeof min !== "number" || !Number.isFinite(min)) {
			issues.push(
				`branchBlueprints.${blueprintKey}.computeSettings.autoscalingLimitMinCu must be a finite number`,
			);
		} else if (min < 0.25) {
			issues.push(
				`branchBlueprints.${blueprintKey}.computeSettings.autoscalingLimitMinCu must be >= 0.25`,
			);
		}
	}
	if (max !== undefined) {
		if (typeof max !== "number" || !Number.isFinite(max)) {
			issues.push(
				`branchBlueprints.${blueprintKey}.computeSettings.autoscalingLimitMaxCu must be a finite number`,
			);
		} else if (max < 0.25) {
			issues.push(
				`branchBlueprints.${blueprintKey}.computeSettings.autoscalingLimitMaxCu must be >= 0.25`,
			);
		}
	}
	if (
		typeof min === "number" &&
		typeof max === "number" &&
		Number.isFinite(min) &&
		Number.isFinite(max) &&
		min > max
	) {
		issues.push(
			`branchBlueprints.${blueprintKey}.computeSettings.autoscalingLimitMinCu (${min}) must be <= autoscalingLimitMaxCu (${max})`,
		);
	}

	if (suspend !== undefined) {
		if (typeof suspend !== "number" || !Number.isInteger(suspend)) {
			issues.push(
				`branchBlueprints.${blueprintKey}.computeSettings.suspendTimeoutSeconds must be an integer`,
			);
		} else if (suspend < -1 || suspend > 604_800) {
			issues.push(
				`branchBlueprints.${blueprintKey}.computeSettings.suspendTimeoutSeconds must be between -1 and 604800`,
			);
		} else if (suspend > 0 && suspend < 60) {
			issues.push(
				`branchBlueprints.${blueprintKey}.computeSettings.suspendTimeoutSeconds must be 0, -1, or between 60 and 604800`,
			);
		}
	}

	for (const k of Object.keys(s)) {
		if (
			k !== "autoscalingLimitMinCu" &&
			k !== "autoscalingLimitMaxCu" &&
			k !== "suspendTimeoutSeconds"
		) {
			issues.push(
				`branchBlueprints.${blueprintKey}.computeSettings has unknown key: ${JSON.stringify(k)}`,
			);
		}
	}
}
