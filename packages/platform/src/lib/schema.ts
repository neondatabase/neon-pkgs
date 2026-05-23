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
 * Zod schema for {@link import("./types.js").BranchConfig} — a concrete, persistent branch
 * managed by `pushConfig`. The map key in `Config.branches` is the literal branch name on
 * Neon, so this schema deliberately has no `pattern` (the key serves that role) and no
 * `ttl` (concrete branches don't expire).
 */
export const branchConfigSchema = z.strictObject({
	parent: z.string().optional(),
	protected: z.boolean().optional(),
	computeSettings: computeSettingsSchema.optional(),
});

/**
 * Zod schema for {@link import("./types.js").BranchBlueprint} — a template for ephemeral
 * branches minted by `branch()`. The `pattern` field is **required** and **must contain a
 * `*` wildcard**; specific-name branches live under `Config.branches` (see
 * {@link branchConfigSchema}) instead.
 *
 * Cross-blueprint `parent` reference checks live on the top-level config schema where we
 * can see every key in both `branches` and `branchBlueprints` at once.
 */
export const branchBlueprintSchema = z.strictObject({
	pattern: z.string().superRefine((value, ctx) => {
		const result = validatePattern(value);
		if ("error" in result) {
			ctx.addIssue({ code: "custom", message: result.error });
			return;
		}
		if (!isWildcardPattern(value)) {
			ctx.addIssue({
				code: "custom",
				message: `pattern must contain a "*" wildcard (got "${value}"). Specific-name branches belong in \`branches\`, not \`branchBlueprints\`.`,
			});
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
 * Zod schema for {@link import("./types.js").EnvKeysConfig}. Both keys are optional and,
 * when present, must be non-empty strings (otherwise `loadEnv` would write into the empty
 * key, silently shadowing every other env var).
 */
export const envKeysConfigSchema = z.strictObject({
	databaseUrl: z.string().min(1, "must not be empty").optional(),
	databaseUrlUnpooled: z.string().min(1, "must not be empty").optional(),
});

/**
 * Top-level zod schema for a Neon Platform config (the value returned by `defineConfig`).
 *
 * Cross-key invariants enforced here:
 *
 * - The key of every entry in `branches` must be a valid, concrete branch name (no
 *   wildcards) — it's the literal name the branch will have on Neon.
 * - `parent` on a `branches` entry must not reference itself, and must match either
 *   another `branches` key or a literal branch name (no wildcards).
 * - `parent` on a `branchBlueprints` entry must match a `branches` key or a literal
 *   branch name. Pointing a blueprint's `parent` at another blueprint key is rejected:
 *   blueprints are wildcards and a parent must resolve to a single concrete branch.
 */
export const configSchema = z
	.strictObject({
		project: projectConfigSchema,
		branches: z.record(z.string(), branchConfigSchema).optional(),
		branchBlueprints: z
			.record(z.string(), branchBlueprintSchema)
			.optional(),
		env: envKeysConfigSchema.optional(),
	})
	.superRefine((cfg, ctx) => {
		const branches = cfg.branches ?? {};
		const blueprints = cfg.branchBlueprints ?? {};
		const branchKeys = new Set(Object.keys(branches));
		const blueprintKeys = new Set(Object.keys(blueprints));

		for (const [key, branch] of Object.entries(branches)) {
			// The map key IS the branch name on Neon. Validate it as a concrete name (a
			// pattern with no wildcard) so users get a clean error here rather than
			// downstream when push tries to create the branch.
			const keyCheck = validatePattern(key);
			if ("error" in keyCheck) {
				ctx.addIssue({
					code: "custom",
					path: ["branches", key],
					message: `branch key "${key}" is not a valid branch name: ${keyCheck.error}`,
				});
			} else if (isWildcardPattern(key)) {
				ctx.addIssue({
					code: "custom",
					path: ["branches", key],
					message: `branch key "${key}" must be a concrete branch name (no wildcards). Move wildcard entries to \`branchBlueprints\`.`,
				});
			}

			validateParentReference({
				ctx,
				path: ["branches", key, "parent"],
				ownKey: key,
				parent: branch.parent,
				branchKeys,
			});
		}

		for (const [key, blueprint] of Object.entries(blueprints)) {
			if (branchKeys.has(key)) {
				ctx.addIssue({
					code: "custom",
					path: ["branchBlueprints", key],
					message: `blueprint key "${key}" collides with a key in \`branches\`. Rename one of them.`,
				});
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
			if (blueprintKeys.has(parent)) {
				ctx.addIssue({
					code: "custom",
					path: ["branchBlueprints", key, "parent"],
					message: `parent must point at a concrete branch (a \`branches\` key or literal name), not another blueprint key "${parent}"`,
				});
				continue;
			}
			if (branchKeys.has(parent)) continue;

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

function validateParentReference(args: {
	ctx: z.RefinementCtx;
	path: (string | number)[];
	ownKey: string;
	parent: string | undefined;
	branchKeys: Set<string>;
}): void {
	const { ctx, path, ownKey, parent, branchKeys } = args;
	if (parent === undefined) return;
	if (parent === ownKey) {
		ctx.addIssue({
			code: "custom",
			path,
			message: "parent must not reference itself",
		});
		return;
	}
	if (branchKeys.has(parent)) return;

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
