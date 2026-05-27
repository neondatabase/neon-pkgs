import { parseDuration } from "./duration.js";
import { ConfigValidationError } from "./errors.js";
import { branchConfigSchema, formatZodIssues } from "./schema.js";
import type { BranchTarget, Config, ResolvedBranchConfig } from "./types.js";

const REGION_PREFIX = /^(aws|azure|gcp)-/;

/**
 * Validate and freeze a Neon Platform branch policy.
 *
 * Used at the top of `neon.ts`:
 * ```ts
 * import { defineConfig } from "@neondatabase/platform/v1";
 *
 * export default defineConfig((branch) => {
 *   if (branch.name === "main") {
 *     return { protected: true, auth: {} };
 *   }
 *   return { parent: "main", ttl: "7d" };
 * });
 * ```
 *
 * Pure function — no I/O, no side effects. The returned policy validates its output every
 * time it is evaluated so errors point at the concrete branch target that triggered them.
 */
export function defineConfig<const C extends Config>(input: C): C {
	if (typeof input !== "function") {
		throw new ConfigValidationError([
			"defineConfig expects a function: `export default defineConfig((branch) => ({ ... }))`.",
			"Project-level config has moved to `neonctl link`; neon.ts now describes branch-level policy only.",
		]);
	}

	return Object.freeze(input) as C;
}

/**
 * Evaluate a branch policy for a specific branch target and return a normalized config.
 */
export function resolveConfig(
	config: Config,
	branch: BranchTarget,
): ResolvedBranchConfig {
	let raw: unknown;
	try {
		raw = config(Object.freeze({ ...branch }));
	} catch (cause) {
		throw new ConfigValidationError([
			`Config function threw while evaluating branch "${branch.name}".`,
			(cause as Error)?.message ?? String(cause),
		]);
	}

	const parsed = branchConfigSchema.safeParse(raw);
	if (!parsed.success) {
		throw new ConfigValidationError(formatZodIssues(parsed.error));
	}

	const cfg = parsed.data;
	const issues: string[] = [];
	let ttlSeconds: number | undefined;
	if (cfg.ttl !== undefined) {
		const parsedTtl = parseDuration(cfg.ttl);
		if ("error" in parsedTtl) {
			issues.push(`ttl: ${parsedTtl.error}`);
		} else {
			ttlSeconds = parsedTtl.seconds;
		}
	}
	if (issues.length > 0) {
		throw new ConfigValidationError(issues);
	}

	const resolved: ResolvedBranchConfig = {
		authEnabled: isServiceEnabled(cfg.auth),
		dataApiEnabled: isServiceEnabled(cfg.dataApi),
	};
	if (cfg.parent !== undefined) resolved.parent = cfg.parent;
	if (ttlSeconds !== undefined) resolved.ttlSeconds = ttlSeconds;
	if (cfg.protected !== undefined) resolved.protected = cfg.protected;
	if (cfg.postgres) {
		resolved.postgres = {
			...(cfg.postgres.computeSettings
				? { computeSettings: { ...cfg.postgres.computeSettings } }
				: {}),
		};
	}
	return resolved;
}

function isServiceEnabled(service: { enabled?: boolean } | undefined): boolean {
	return service !== undefined && service.enabled !== false;
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
