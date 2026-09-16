import { branchTuningSchema } from "./schema.js";
import type {
	BranchTarget,
	BranchTuning,
	BucketDef,
	Config,
	FunctionDef,
	PreviewInput,
	ServiceToggleInput,
} from "./types.js";

/** The home a static service can be authored in. */
export type AuthoredServiceKey = "aiGateway" | "functions" | "buckets";

const PREVIEW_PATH: Record<AuthoredServiceKey, string> = {
	aiGateway: "preview.aiGateway",
	functions: "preview.functions",
	buckets: "preview.buckets",
};

const GA_PATH: Record<AuthoredServiceKey, string> = {
	aiGateway: "aiGateway",
	functions: "functions",
	buckets: "buckets",
};

/** Functions declared at the top level or under deprecated `preview.functions`. */
export function authoredFunctions(
	config: Pick<Config, "functions" | "preview">,
): Record<string, FunctionDef> | undefined {
	return config.functions ?? config.preview?.functions;
}

/** Buckets declared at the top level or under deprecated `preview.buckets`. */
export function authoredBuckets(
	config: Pick<Config, "buckets" | "preview">,
): Record<string, BucketDef> | undefined {
	return config.buckets ?? config.preview?.buckets;
}

/** AI Gateway toggle at the top level or under deprecated `preview.aiGateway`. */
export function authoredAiGateway(
	config: Pick<Config, "aiGateway" | "preview">,
): ServiceToggleInput | undefined {
	return config.aiGateway ?? config.preview?.aiGateway;
}

/**
 * Fold top-level GA keys and deprecated `preview` keys into the shape
 * {@link import("./define-config.js").resolveConfig} already consumes.
 *
 * Collision between the two homes is rejected at validation time, so each field
 * has at most one source. An empty `preview: {}` still produces an empty object
 * so resolve keeps today's `resolved.preview` of empty arrays.
 */
export function mergeAuthoredPreview(config: Config): PreviewInput | undefined {
	const functions = authoredFunctions(config);
	const buckets = authoredBuckets(config);
	const aiGateway = authoredAiGateway(config);
	if (
		functions === undefined &&
		buckets === undefined &&
		aiGateway === undefined &&
		config.preview === undefined
	) {
		return undefined;
	}
	const merged: PreviewInput = {};
	if (aiGateway !== undefined) merged.aiGateway = aiGateway;
	if (functions !== undefined) merged.functions = functions;
	if (buckets !== undefined) merged.buckets = buckets;
	return merged;
}

/** Per-function branch tuning from top-level `functions` or deprecated `preview.functions`. */
export function authoredFunctionTuning(
	tuning: BranchTuning,
): NonNullable<BranchTuning["functions"]> {
	return tuning.functions ?? tuning.preview?.functions ?? {};
}

/**
 * Deprecated authoring paths still present on the policy. Used by the CLI deploy/apply
 * warning. Empty `preview: {}` contributes nothing.
 */
export function deprecatedPreviewAuthoring(
	config: Pick<Config, "preview">,
	tuning?: Pick<BranchTuning, "preview" | "functions">,
): string[] {
	const keys: string[] = [];
	for (const key of ["aiGateway", "functions", "buckets"] as const) {
		if (config.preview?.[key] !== undefined) keys.push(PREVIEW_PATH[key]);
	}
	if (tuning?.preview?.functions !== undefined) {
		keys.push("branch.preview.functions");
	}
	return keys;
}

/** One-line deploy warning naming each deprecated path and its GA replacement. */
export function previewGaWarningMessage(keys: readonly string[]): string {
	const lifts = keys.map((key) => {
		switch (key) {
			case "preview.aiGateway":
				return `${PREVIEW_PATH.aiGateway} → ${GA_PATH.aiGateway}`;
			case "preview.functions":
				return `${PREVIEW_PATH.functions} → ${GA_PATH.functions}`;
			case "preview.buckets":
				return `${PREVIEW_PATH.buckets} → ${GA_PATH.buckets}`;
			case "branch.preview.functions":
				return "branch.preview.functions → branch.functions";
			default:
				return key;
		}
	});
	return `These neon.ts keys are now GA and can be lifted out of preview: ${lifts.join(", ")}.`;
}

const WARNING_BRANCH_TARGETS: BranchTarget[] = [
	{ name: "main", exists: true, isDefault: true },
	{ name: "preview", exists: false, isDefault: false },
];

/**
 * Deprecation warning for a policy that still authors GA services under `preview`.
 * Evaluates `branch` against a default and a child target so child-only
 * `preview.functions` tuning is visible without a live apply.
 */
export function previewGaWarningForConfig(config: Config): string | null {
	const keys = new Set(deprecatedPreviewAuthoring(config));
	if (typeof config.branch === "function") {
		for (const branch of WARNING_BRANCH_TARGETS) {
			try {
				const parsed = branchTuningSchema.safeParse(
					config.branch(branch) ?? {},
				);
				if (!parsed.success) continue;
				for (const key of deprecatedPreviewAuthoring(
					config,
					parsed.data,
				)) {
					keys.add(key);
				}
			} catch {
				// A throwing closure is a resolveConfig error, not a warning path.
			}
		}
	}
	if (keys.size === 0) return null;
	return previewGaWarningMessage([...keys]);
}
