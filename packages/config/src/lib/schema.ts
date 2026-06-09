import { z } from "zod";
import { parseDuration, parseSuspendTimeout } from "./duration.js";
import { isWildcardPattern, validatePattern } from "./patterns.js";

/**
 * Zod schema for {@link import("./types.js").ComputeSettings}.
 *
 * - CU values must be one of: 0.25, 0.5, 1, 2, 4, 8
 * - `suspendTimeout` can be:
 *   - `false` (never suspend)
 *   - duration string like "5m", "1h" (must be 60s-604800s when parsed)
 *   - number in seconds (60-604800, or -1/0 for special values)
 *   - `undefined` (use platform default)
 *
 * Cross-field invariants (min <= max) are enforced via `superRefine`.
 */
export const computeSettingsSchema = z
	.strictObject({
		autoscalingLimitMinCu: z
			.union([
				z.literal(0.25),
				z.literal(0.5),
				z.literal(1),
				z.literal(2),
				z.literal(4),
				z.literal(8),
			])
			.optional(),
		autoscalingLimitMaxCu: z
			.union([
				z.literal(0.25),
				z.literal(0.5),
				z.literal(1),
				z.literal(2),
				z.literal(4),
				z.literal(8),
			])
			.optional(),
		suspendTimeout: z
			.union([z.literal(false), z.string(), z.number()])
			.optional()
			.superRefine((value, ctx) => {
				if (value === undefined) return; // undefined is valid (use platform default)
				const result = parseSuspendTimeout(value);
				if ("error" in result) {
					ctx.addIssue({
						code: "custom",
						message: result.error,
					});
				}
			}),
	})
	.superRefine((settings, ctx) => {
		const { autoscalingLimitMinCu: min, autoscalingLimitMaxCu: max } =
			settings;
		if (min !== undefined && max !== undefined && min > max) {
			ctx.addIssue({
				code: "custom",
				path: ["autoscalingLimitMinCu"],
				message: `autoscalingLimitMinCu (${min}) must be <= autoscalingLimitMaxCu (${max})`,
			});
		}
	});

/** Object form of a service toggle (`{ enabled?: boolean }`). */
export const serviceToggleSchema = z.strictObject({
	enabled: z.boolean().optional(),
});

/** A service toggle as written in a policy: `boolean` or `{ enabled?: boolean }`. */
export const serviceToggleInputSchema = z.union([
	z.boolean(),
	serviceToggleSchema,
]);

export const postgresConfigSchema = z.strictObject({
	computeSettings: computeSettingsSchema.optional(),
});

/**
 * Branch-unique function slug. Mirrors the Neon Functions API path-segment rule
 * (`platform/internal/platform/functions/name.go`): 1–20 lowercase letters and digits.
 * Used as the **key schema** of the `preview.functions` record, so a bad slug fails
 * validation with a path pointing at the offending key and duplicate slugs are impossible
 * by construction (object keys are unique).
 */
const functionSlugSchema = z
	.string()
	.regex(
		/^[a-z0-9]{1,20}$/,
		"function slug must be 1-20 lowercase letters and digits (no hyphens or other characters)",
	);

/** Bucket name: 1–255 chars. Used as the key schema of the `preview.buckets` record. */
const bucketNameSchema = z.string().min(1).max(255);

/**
 * Per-function environment map. Every value must be a defined string: a `process.env.X`
 * that is unset surfaces as `undefined` and is rejected here (rather than silently
 * shipping `undefined` into the deployment).
 */
const functionEnvSchema = z.record(z.string(), z.string());

/**
 * TCP port for a function's local dev server. Excludes 0 (which means "any port" to the OS
 * — `neon dev` expresses "pick one for me" by omitting `port`, not by passing 0).
 */
const devPortSchema = z.number().int().min(1).max(65535);

/**
 * Local-dev settings for a function (`neon dev` only; never affects deploy). `port` and
 * `portless` are independent: when `portless` is true, portless assigns the port itself
 * (so `port` is ignored); otherwise `port` is bound exactly when set, or a free port is
 * found when omitted.
 */
const functionDevConfigSchema = z.strictObject({
	port: devPortSchema.optional(),
	portless: z.boolean().optional(),
});

const memoryMibSchema = z.union([
	z.literal(256),
	z.literal(512),
	z.literal(1024),
	z.literal(2048),
	z.literal(4096),
	z.literal(8192),
]);

const runtimeSchema = z.literal("nodejs24");

/**
 * Static definition of a function (existence). The slug is the record key (validated by
 * {@link functionSlugSchema}), so it is not a field here. Deploy tuning (`memoryMib`,
 * `runtime`) lives in the `branch` closure, not here.
 */
export const functionDefSchema = z.strictObject({
	name: z.string().min(1).max(255),
	source: z.string().min(1),
	env: functionEnvSchema.optional(),
	dev: functionDevConfigSchema.optional(),
});

/** Static definition of a bucket (existence). Name is the record key. */
export const bucketDefSchema = z.strictObject({
	access: z
		.union([z.literal("private"), z.literal("public_read")])
		.optional(),
});

/** Static, beta Preview feature set: AI Gateway toggle + functions/buckets records. */
export const previewInputSchema = z.strictObject({
	aiGateway: serviceToggleInputSchema.optional(),
	functions: z.record(functionSlugSchema, functionDefSchema).optional(),
	buckets: z.record(bucketNameSchema, bucketDefSchema).optional(),
});

/** Per-function deploy tuning returned by the `branch` closure. */
export const functionTuningSchema = z.strictObject({
	memoryMib: memoryMibSchema.optional(),
	runtime: runtimeSchema.optional(),
});

/** Per-branch Preview tuning. Keys must be slugs declared in the static `preview`. */
const previewTuningSchema = z.strictObject({
	functions: z.record(functionSlugSchema, functionTuningSchema).optional(),
});

/**
 * The object returned by the `branch` closure. Validated on every `resolveConfig` call so
 * tuning errors point at the concrete branch target that triggered them.
 */
export const branchTuningSchema = z
	.strictObject({
		parent: z.string().optional(),
		protected: z.boolean().optional(),
		ttl: z
			.union([z.string(), z.number()])
			.optional()
			.superRefine((value, ctx) => {
				if (value === undefined) return;
				const result = parseDuration(value);
				if ("error" in result) {
					ctx.addIssue({ code: "custom", message: result.error });
				}
			}),
		postgres: postgresConfigSchema.optional(),
		preview: previewTuningSchema.optional(),
	})
	.superRefine((cfg, ctx) => {
		validateParentReference({
			ctx,
			path: ["parent"],
			parent: cfg.parent,
		});
	});

/**
 * The top-level object accepted by `defineConfig`. The `branch` closure is validated
 * structurally as a function here; its returned tuning is validated per-evaluation by
 * {@link branchTuningSchema} inside `resolveConfig`.
 */
export const configInputSchema = z.strictObject({
	auth: serviceToggleInputSchema.optional(),
	dataApi: serviceToggleInputSchema.optional(),
	preview: previewInputSchema.optional(),
	branch: z
		.custom<(...args: unknown[]) => unknown>(
			(value) => typeof value === "function",
			{
				message:
					"branch must be a function: `branch: (branch) => ({ … })`",
			},
		)
		.optional(),
});

function validateParentReference(args: {
	ctx: z.RefinementCtx;
	path: (string | number)[];
	parent: string | undefined;
}): void {
	const { ctx, path, parent } = args;
	if (parent === undefined) return;

	const patternCheck = validatePattern(parent);
	if ("error" in patternCheck) {
		ctx.addIssue({ code: "custom", path, message: patternCheck.error });
	} else if (isWildcardPattern(parent)) {
		ctx.addIssue({
			code: "custom",
			path,
			message: `parent must be a concrete branch name (no wildcards), got "${parent}"`,
		});
	}
}

/**
 * Convert the structured {@link z.ZodError} produced by `configSchema.safeParse` into the
 * `string[]` shape used by {@link import("./errors.js").ConfigValidationError}.
 *
 * Issue paths are rendered as dot-separated property accesses (`postgres.computeSettings`)
 * and unknown-key issues from `strictObject` are normalised so the message contains the
 * substring "unknown key" — keeping pre-zod assertions in test suites and downstream tools
 * stable.
 */
export function formatZodIssues(error: z.ZodError): string[] {
	return error.issues.map((issue) => {
		const path = renderPath(issue.path);
		const message = normaliseIssueMessage(issue);
		return path ? `${path}: ${message}` : message;
	});
}

function renderPath(path: ReadonlyArray<PropertyKey>): string {
	let out = "";
	for (const segment of path) {
		if (typeof segment === "number") out += `[${segment}]`;
		else if (out === "") out += String(segment);
		else out += `.${String(segment)}`;
	}
	return out;
}

function normaliseIssueMessage(issue: z.core.$ZodIssue): string {
	if (issue.code === "unrecognized_keys") {
		const keys = (issue as z.core.$ZodIssueUnrecognizedKeys).keys ?? [];
		const formatted = keys.map((k) => JSON.stringify(k)).join(", ");
		return `unknown key${keys.length === 1 ? "" : "s"}: ${formatted}`;
	}
	return issue.message;
}
