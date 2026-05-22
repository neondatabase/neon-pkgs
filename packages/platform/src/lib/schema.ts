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

/**
 * Zod schema for {@link import("./types.js").BranchBlueprint}. Validates pattern, ttl,
 * and (per-field) compute settings; the cross-blueprint `parent` reference check lives on
 * the top-level config schema where we can see every blueprint key at once.
 */
export const branchBlueprintSchema = z.strictObject({
	pattern: z
		.string()
		.optional()
		.superRefine((value, ctx) => {
			if (value === undefined) return;
			const result = validatePattern(value);
			if ("error" in result) {
				ctx.addIssue({ code: "custom", message: result.error });
			}
		}),
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
	parent: z.string().optional(),
	computeSettings: computeSettingsSchema.optional(),
});

/**
 * Zod schema for {@link import("./types.js").ProjectConfig}.
 *
 * Refinement messages omit the field prefix on purpose; `formatZodIssues` renders the path
 * (`project.name`, `project.pgVersion`, …) so authoring the message both ways would
 * duplicate the field name in the user-visible error.
 */
export const projectConfigSchema = z.strictObject({
	name: z
		.string()
		.min(1, "must not be empty")
		.max(256, "must be <= 256 characters")
		.refine((v) => v.trim() === v, {
			message: "has leading or trailing whitespace",
		}),
	region: z
		.string()
		.regex(/^[a-z0-9-]+$/, "must be lowercase letters, digits, and '-'")
		.optional(),
	pgVersion: z
		.number()
		.int("pgVersion must be an integer")
		.min(14, "pgVersion must be between 14 and 18")
		.max(18, "pgVersion must be between 14 and 18")
		.optional(),
});

/**
 * Top-level zod schema for a Neon Platform config (the value returned by `defineConfig`).
 *
 * Cross-blueprint invariants are enforced here:
 * - `parent` must not reference its own blueprint key.
 * - `parent` either matches another blueprint key, or is a valid concrete branch name
 *   (wildcard patterns are disallowed for parents).
 */
export const configSchema = z
	.strictObject({
		project: projectConfigSchema,
		branchBlueprints: z
			.record(z.string(), branchBlueprintSchema)
			.optional(),
	})
	.superRefine((cfg, ctx) => {
		const blueprints = cfg.branchBlueprints;
		if (!blueprints) return;
		const keys = new Set(Object.keys(blueprints));
		for (const [key, blueprint] of Object.entries(blueprints)) {
			// When a blueprint omits `pattern`, the blueprint key itself is used as the
			// pattern at resolve time. Surface invalid keys here so the user gets a clear
			// error instead of a confusing "pattern: …" message buried deep in the path.
			if (blueprint.pattern === undefined) {
				const keyAsPattern = validatePattern(key);
				if ("error" in keyAsPattern) {
					ctx.addIssue({
						code: "custom",
						path: ["branchBlueprints", key],
						message: `blueprint key "${key}" is used as the default pattern but is invalid: ${keyAsPattern.error}`,
					});
				}
			}

			const parent = blueprint.parent;
			if (parent === undefined) continue;
			if (parent === key) {
				ctx.addIssue({
					code: "custom",
					path: ["branchBlueprints", key, "parent"],
					message: "parent must not reference itself",
				});
				continue;
			}
			if (keys.has(parent)) continue;

			const patternCheck = validatePattern(parent);
			if ("error" in patternCheck) {
				ctx.addIssue({
					code: "custom",
					path: ["branchBlueprints", key, "parent"],
					message: patternCheck.error,
				});
			} else if (isWildcardPattern(parent)) {
				ctx.addIssue({
					code: "custom",
					path: ["branchBlueprints", key, "parent"],
					message: `parent must be a concrete branch name (no wildcards), got "${parent}"`,
				});
			}
		}
	});

/**
 * Convert the structured {@link z.ZodError} produced by `configSchema.safeParse` into the
 * `string[]` shape used by {@link import("./errors.js").ConfigValidationError}.
 *
 * Issue paths are rendered as dot-separated property accesses (`branchBlueprints.preview.ttl`)
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
