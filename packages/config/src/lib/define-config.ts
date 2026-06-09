import { parseDuration } from "./duration.js";
import { ConfigValidationError } from "./errors.js";
import {
	branchTuningSchema,
	configInputSchema,
	formatZodIssues,
} from "./schema.js";
import type {
	BranchTarget,
	BranchTuning,
	BranchTuningFn,
	Config,
	FunctionDef,
	FunctionTuning,
	PreviewInput,
	ResolvedBranchConfig,
	ResolvedFunctionConfig,
	ResolvedPreviewConfig,
	ServiceToggleInput,
} from "./types.js";

/** Default deploy parameters applied to functions that omit them in `neon.ts`. */
const DEFAULT_FUNCTION_RUNTIME = "nodejs24" as const;

const REGION_PREFIX = /^(aws|azure|gcp)-/;

/**
 * Validate and freeze a Neon Platform branch policy.
 *
 * Used at the top of `neon.ts`:
 * ```ts
 * import { defineConfig } from "@neondatabase/config/v1";
 *
 * export default defineConfig({
 *   auth: true,
 *   preview: {
 *     functions: {
 *       hello: { name: "Hello", source: "./functions/hello.ts", dev: { port: 8787 } },
 *     },
 *   },
 *   branch: (branch) => ({ protected: branch.name === "main" }),
 * });
 * ```
 *
 * The policy is split into a **static** existential set (top-level `auth` / `dataApi`
 * toggles and the beta `preview` block) and a **dynamic** per-branch `branch` closure. The
 * static half determines which secrets exist — so `NeonEnv<typeof config>` and `parseEnv`
 * are exact — while the closure can only *tune* a branch (lifecycle, compute, per-function
 * deploy settings), never change what exists.
 *
 * The `branch` callback receives a read-only {@link BranchTarget} descriptor of the branch
 * being decided for (not a live handle); switch on its facts (`branch.name`,
 * `branch.isDefault`, `branch.exists`, …) and **return** the desired tuning. It runs in two
 * modes: against an existing branch (fields populated from Neon) and during pre-create
 * evaluation (`exists: false`, `id` undefined).
 *
 * Pure: no I/O, no side effects. The static parts are validated here; the closure's output
 * is validated every time it is evaluated so errors point at the concrete branch target.
 */
export function defineConfig<
	const Auth extends ServiceToggleInput | undefined = undefined,
	const DataApi extends ServiceToggleInput | undefined = undefined,
	const Preview extends PreviewInput | undefined = undefined,
>(input: {
	auth?: Auth;
	dataApi?: DataApi;
	preview?: Preview;
	branch?: BranchTuningFn<Preview>;
}): Config<Auth, DataApi, Preview> {
	if (typeof input === "function") {
		throw new ConfigValidationError([
			"defineConfig now expects an object, not a function: `export default defineConfig({ auth: true, preview: { … }, branch: (branch) => ({ … }) })`.",
			"The static services/preview set moved to the top level; per-branch logic moved into the `branch` closure.",
		]);
	}
	if (input === null || typeof input !== "object") {
		throw new ConfigValidationError([
			"defineConfig expects a configuration object: `export default defineConfig({ … })`.",
		]);
	}

	const parsed = configInputSchema.safeParse(input);
	if (!parsed.success) {
		throw new ConfigValidationError(formatZodIssues(parsed.error));
	}

	return Object.freeze({ ...input }) as Config<Auth, DataApi, Preview>;
}

/**
 * Evaluate a branch policy for a specific branch target and return a normalized config.
 *
 * Merges the static existential set (services + preview functions/buckets) with the
 * per-branch tuning returned by the `branch` closure into the same {@link
 * ResolvedBranchConfig} the rest of the runtime (diff / push / fetchEnv) consumes.
 */
export function resolveConfig(
	config: Config,
	branch: BranchTarget,
): ResolvedBranchConfig {
	const tuning = evaluateBranchTuning(config.branch, branch);

	const resolved: ResolvedBranchConfig = {
		authEnabled: isServiceEnabled(config.auth),
		dataApiEnabled: isServiceEnabled(config.dataApi),
	};
	if (tuning.parent !== undefined) resolved.parent = tuning.parent;
	if (tuning.ttl !== undefined) {
		// `branchTuningSchema` already validated `ttl` with the same `parseDuration`, so
		// this only converts the validated value to seconds — it cannot fail here.
		const parsedTtl = parseDuration(tuning.ttl);
		if (!("error" in parsedTtl)) resolved.ttlSeconds = parsedTtl.seconds;
	}
	if (tuning.protected !== undefined) resolved.protected = tuning.protected;
	if (tuning.postgres?.computeSettings) {
		resolved.postgres = {
			computeSettings: { ...tuning.postgres.computeSettings },
		};
	}

	const preview = resolvePreviewConfig(config.preview, tuning);
	if (preview) resolved.preview = preview;

	return resolved;
}

/**
 * Run the `branch` closure (when present) for the target and validate its output. The
 * closure is optional — a fully static policy resolves with empty tuning.
 */
function evaluateBranchTuning(
	branchFn: BranchTuningFn | undefined,
	target: BranchTarget,
): BranchTuning {
	if (!branchFn) return {};
	let raw: unknown;
	try {
		raw = branchFn(Object.freeze({ ...target }));
	} catch (cause) {
		throw new ConfigValidationError([
			`Branch policy threw while evaluating branch "${target.name}".`,
			(cause as Error)?.message ?? String(cause),
		]);
	}
	const parsed = branchTuningSchema.safeParse(raw ?? {});
	if (!parsed.success) {
		throw new ConfigValidationError(formatZodIssues(parsed.error));
	}
	return parsed.data as BranchTuning;
}

function isServiceEnabled(toggle: ServiceToggleInput | undefined): boolean {
	if (toggle === undefined) return false;
	if (typeof toggle === "boolean") return toggle;
	return toggle.enabled !== false;
}

/**
 * Normalize the static {@link PreviewInput} (merged with per-branch function tuning) into a
 * {@link ResolvedPreviewConfig}. Returns `undefined` when the policy declares no `preview`
 * block so the field can be omitted entirely. Function slugs / bucket names come from the
 * record keys.
 */
function resolvePreviewConfig(
	preview: PreviewInput | undefined,
	tuning: BranchTuning,
): ResolvedPreviewConfig | undefined {
	if (!preview) return undefined;
	const fnTuning = tuning.preview?.functions ?? {};
	const functions: ResolvedFunctionConfig[] = Object.entries(
		preview.functions ?? {},
	).map(([slug, def]) =>
		resolveFunctionConfig(slug, def, fnTuning[slug] ?? {}),
	);
	const buckets = Object.entries(preview.buckets ?? {}).map(
		([name, def]) => ({
			name,
			access: def.access ?? "private",
		}),
	);
	return {
		functions,
		buckets,
		aiGatewayEnabled: isServiceEnabled(preview.aiGateway),
	};
}

function resolveFunctionConfig(
	slug: string,
	def: FunctionDef,
	tuning: FunctionTuning,
): ResolvedFunctionConfig {
	return {
		slug,
		name: def.name,
		source: def.source,
		env: { ...(def.env ?? {}) },
		runtime: tuning.runtime ?? DEFAULT_FUNCTION_RUNTIME,
		// Passed through untouched (no defaults); only `neon dev` reads it.
		...(def.dev ? { dev: def.dev } : {}),
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
