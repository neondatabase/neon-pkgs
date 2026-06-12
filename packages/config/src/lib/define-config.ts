import { parseBranchTtl } from "./duration.js";
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
	DataApiInput,
	DataApiSettings,
	FunctionDef,
	FunctionTuning,
	PreviewInput,
	ResolvedBranchConfig,
	ResolvedDataApiConfig,
	ResolvedFunctionConfig,
	ResolvedPreviewConfig,
	ServiceEnabled,
	ServiceToggleInput,
} from "./types.js";

/** Default deploy parameters applied to functions that omit them in `neon.ts`. */
const DEFAULT_FUNCTION_RUNTIME = "nodejs24" as const;

const REGION_PREFIX = /^(aws|azure|gcp)-/;

/**
 * Whether a `dataApi` toggle is **enabled and verified by Neon Auth** at the type level: it is
 * on (see {@link ServiceEnabled}) and not the explicit `authProvider: "external"` variant
 * (so the default / `"neon"` provider). This is the case that requires top-level Neon Auth.
 */
type DataApiUsesNeonAuth<DataApi> = ServiceEnabled<DataApi> extends true
	? [DataApi] extends [{ authProvider: "external" }]
		? false
		: true
	: false;

/** An `auth` toggle value that is statically guaranteed enabled (`true` / `{}` / `{ enabled: true }`). */
type EnabledAuthToggle = true | { enabled?: true };

/**
 * Static cross-field guard for {@link defineConfig}. When the policy enables a Neon-Auth
 * Data API (`authProvider: "neon"`, the default) but does **not** enable top-level `auth`,
 * this resolves to `{ auth: EnabledAuthToggle }` — intersected into the parameter type, it
 * makes `auth` required and rejects `auth: false` / a missing `auth`, surfacing the rule at
 * author time. Otherwise it is `unknown` (a no-op intersection). The runtime `superRefine`
 * in {@link configInputSchema} enforces the same invariant for non-typed callers.
 */
type RequiresNeonAuth<Auth, DataApi> = DataApiUsesNeonAuth<DataApi> extends true
	? ServiceEnabled<Auth> extends true
		? unknown
		: { auth: EnabledAuthToggle }
	: unknown;

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
	const DataApi extends DataApiInput | undefined = undefined,
	const Preview extends PreviewInput | undefined = undefined,
>(
	input: {
		// Each field is intersected with its concrete interface (not just typed as the bare
		// generic). The generic alone — e.g. `preview?: Preview` — gives editors no members to
		// complete against in the object-literal position (they see `{} | undefined`), so you
		// lose hints for `aiGateway` / `functions` / `buckets`. `& PreviewInput` restores the
		// full shape for autocomplete while still inferring the `const` literal that types the
		// `branch` closure's slugs (BranchTuningFn<Preview>) and the returned Config.
		auth?: Auth & ServiceToggleInput;
		dataApi?: DataApi & DataApiInput;
		preview?: Preview & PreviewInput;
		branch?: BranchTuningFn<Preview>;
	} & RequiresNeonAuth<Auth, DataApi>,
): Config<Auth, DataApi, Preview> {
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
		dataApiEnabled: isDataApiEnabled(config.dataApi),
	};
	const dataApi = resolveDataApi(config.dataApi);
	if (dataApi) resolved.dataApi = dataApi;
	if (tuning.parent !== undefined) resolved.parent = tuning.parent;
	if (tuning.ttl !== undefined) {
		// `branchTuningSchema` already validated `ttl` with the same `parseBranchTtl`, so
		// this only converts the validated value to seconds — it cannot fail here.
		const parsedTtl = parseBranchTtl(tuning.ttl);
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

/** Whether a {@link DataApiInput} is enabled (present object/`true` unless `enabled: false`). */
function isDataApiEnabled(input: DataApiInput | undefined): boolean {
	if (input === undefined) return false;
	if (typeof input === "boolean") return input;
	return input.enabled !== false;
}

/**
 * Normalize a {@link DataApiInput} into a {@link ResolvedDataApiConfig}, or `undefined` when
 * the Data API is not enabled. `authProvider` defaults to `"neon"`; the external-IdP wiring
 * is carried through only for the `"external"` provider; `settings` is copied with its
 * `undefined` entries dropped so diffing only considers fields the policy actually set.
 */
function resolveDataApi(
	input: DataApiInput | undefined,
): ResolvedDataApiConfig | undefined {
	if (!isDataApiEnabled(input)) return undefined;
	if (typeof input !== "object") {
		// Bare `true`: enabled with Neon Auth and all-default settings.
		return { authProvider: "neon" };
	}
	const authProvider = input.authProvider ?? "neon";
	const resolved: ResolvedDataApiConfig = { authProvider };
	if (authProvider === "external") {
		if (input.jwksUrl !== undefined) resolved.jwksUrl = input.jwksUrl;
		if (input.providerName !== undefined)
			resolved.providerName = input.providerName;
		if (input.jwtAudience !== undefined)
			resolved.jwtAudience = input.jwtAudience;
	}
	const settings = normalizeDataApiSettings(input.settings);
	if (settings) resolved.settings = settings;
	return resolved;
}

/** Copy a {@link DataApiSettings}, dropping `undefined` entries; `undefined` when empty. */
function normalizeDataApiSettings(
	settings: DataApiSettings | undefined,
): DataApiSettings | undefined {
	if (!settings) return undefined;
	const out: DataApiSettings = {};
	for (const [key, value] of Object.entries(settings)) {
		if (value !== undefined) {
			(out as Record<string, unknown>)[key] = value;
		}
	}
	return Object.keys(out).length > 0 ? out : undefined;
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
