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

export const serviceToggleSchema = z.strictObject({
	enabled: z.boolean().optional(),
});

export const postgresConfigSchema = z.strictObject({
	computeSettings: computeSettingsSchema.optional(),
});

export const branchConfigSchema = z
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
		auth: serviceToggleSchema.optional(),
		dataApi: serviceToggleSchema.optional(),
	})
	.superRefine((cfg, ctx) => {
		validateParentReference({
			ctx,
			path: ["parent"],
			parent: cfg.parent,
		});
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

export const configSchema = z.function({
	input: [z.unknown()],
	output: z.unknown(),
});

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
