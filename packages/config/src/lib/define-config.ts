import { parseDuration } from "./duration.js";
import { ConfigValidationError } from "./errors.js";
import { branchConfigSchema, formatZodIssues } from "./schema.js";
import type {
	BranchTarget,
	Config,
	FunctionConfig,
	PreviewConfig,
	ResolvedBranchConfig,
	ResolvedFunctionConfig,
	ResolvedPreviewConfig,
} from "./types.js";

/** Default deploy parameters applied to functions that omit them in `neon.ts`. */
const DEFAULT_FUNCTION_RUNTIME = "nodejs24" as const;
const DEFAULT_FUNCTION_MEMORY_MIB = 512 as const;

const REGION_PREFIX = /^(aws|azure|gcp)-/;

/**
 * Validate and freeze a Neon Platform branch policy.
 *
 * Used at the top of `neon.ts`:
 * ```ts
 * import { defineConfig } from "@neondatabase/config/v1";
 *
 * export default defineConfig((branch) => {
 *   if (branch.name === "main") {
 *     return { protected: true, auth: {} };
 *   }
 *   return { parent: "main", ttl: "7d" };
 * });
 * ```
 *
 * The `branch` parameter is a **read-only {@link BranchTarget} descriptor** of the branch
 * this policy invocation is deciding for — not a live branch handle. You don't mutate it
 * (`branch.protected = true` does nothing); you switch on its facts (`branch.name`,
 * `branch.isDefault`, `branch.exists`, …) and **return** the desired {@link BranchConfig}.
 * The same callback runs in two modes: against an existing branch (fields populated from
 * Neon) and during pre-create evaluation (`exists: false`, `id` undefined).
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
	if (cfg.preview) {
		resolved.preview = resolvePreviewConfig(cfg.preview);
	}
	return resolved;
}

function isServiceEnabled(service: { enabled?: boolean } | undefined): boolean {
	return service !== undefined && service.enabled !== false;
}

/**
 * Normalize a {@link PreviewConfig} into a {@link ResolvedPreviewConfig}: apply per-function
 * deploy defaults, default each bucket's access level to `private`, and collapse the
 * `aiGateway` toggle to a boolean using the same present-and-not-`false` rule as
 * `auth` / `dataApi`.
 */
function resolvePreviewConfig(preview: PreviewConfig): ResolvedPreviewConfig {
	return {
		functions: (preview.functions ?? []).map(resolveFunctionConfig),
		buckets: (preview.buckets ?? []).map((bucket) => ({
			name: bucket.name,
			access: bucket.access ?? "private",
		})),
		aiGatewayEnabled: isServiceEnabled(preview.aiGateway),
	};
}

function resolveFunctionConfig(fn: FunctionConfig): ResolvedFunctionConfig {
	return {
		slug: fn.slug,
		name: fn.name,
		source: fn.source,
		env: { ...(fn.env ?? {}) },
		runtime: fn.runtime ?? DEFAULT_FUNCTION_RUNTIME,
		memoryMib: fn.memoryMib ?? DEFAULT_FUNCTION_MEMORY_MIB,
		// Passed through untouched (no defaults); only `neon dev` reads it.
		...(fn.dev ? { dev: fn.dev } : {}),
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
