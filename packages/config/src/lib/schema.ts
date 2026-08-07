import { z } from "zod";
import { parseBranchTtl, parseSuspendTimeout } from "./duration.js";
import { externalPackageRoot } from "./external-packages.js";
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

/**
 * Reusable Data API runtime settings (camelCase mirror of the Neon API `DataAPISettings`).
 * `strictObject` so a typo / snake_case key fails loudly instead of being silently dropped.
 */
export const dataApiSettingsSchema = z.strictObject({
	dbAggregatesEnabled: z.boolean().optional(),
	dbAnonRole: z.string().optional(),
	dbExtraSearchPath: z.string().optional(),
	dbMaxRows: z.number().int().optional(),
	dbSchemas: z.array(z.string()).optional(),
	jwtRoleClaimKey: z.string().optional(),
	jwtCacheMaxLifetime: z.number().int().optional(),
	openapiMode: z
		.union([z.literal("ignore-privileges"), z.literal("disabled")])
		.optional(),
	serverCorsAllowedOrigins: z.string().optional(),
	serverTimingEnabled: z.boolean().optional(),
});

/** Names of the external-IdP-only fields, forbidden when `authProvider` is `"neon"`. */
const DATA_API_EXTERNAL_ONLY_KEYS = [
	"jwksUrl",
	"providerName",
	"jwtAudience",
] as const;

/**
 * Object form of the `dataApi` toggle. A single `strictObject` plus a `superRefine` (rather
 * than a discriminated union) so the `"neon"` default works without the discriminator being
 * present, and so the "external-only field with authProvider neon" error points at the exact
 * offending key — mirroring the `?: never` type-level guard at runtime.
 */
export const dataApiConfigSchema = z
	.strictObject({
		enabled: z.boolean().optional(),
		authProvider: z
			.union([z.literal("neon"), z.literal("external")])
			.optional(),
		jwksUrl: z.string().optional(),
		providerName: z.string().optional(),
		jwtAudience: z.string().optional(),
		settings: dataApiSettingsSchema.optional(),
	})
	.superRefine((cfg, ctx) => {
		const provider = cfg.authProvider ?? "neon";
		if (provider !== "neon") return;
		for (const key of DATA_API_EXTERNAL_ONLY_KEYS) {
			if (cfg[key] !== undefined) {
				ctx.addIssue({
					code: "custom",
					path: [key],
					message: `${key} is only allowed with authProvider: "external" — Neon supplies it for authProvider: "neon".`,
				});
			}
		}
	});

/** A `dataApi` toggle as written in a policy: `boolean` or {@link dataApiConfigSchema}. */
export const dataApiInputSchema = z.union([z.boolean(), dataApiConfigSchema]);

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
 * A single function environment-variable value. Must be a defined string: a `process.env.X`
 * that is unset evaluates to `undefined`, and the bare `z.string()` message for that case
 * (`Invalid input: expected string, received undefined`) gives no hint that an env var is the
 * culprit. The custom `error` replaces *only* the `undefined` case with a message that names
 * the offending function + env key (read from the issue path) and how to fix it; any other
 * wrong type keeps zod's default (`expected string, received number`, …).
 */
const functionEnvValueSchema = z.string({
	error: (issue) => {
		if (issue.input !== undefined) return undefined;
		const path = issue.path ?? [];
		const key = path.length > 0 ? String(path[path.length - 1]) : undefined;
		const functionsIndex = path.indexOf("functions");
		const slug =
			functionsIndex >= 0 && functionsIndex + 1 < path.length
				? String(path[functionsIndex + 1])
				: undefined;
		const subject =
			slug !== undefined && key !== undefined
				? `Environment variable "${key}" for function "${slug}"`
				: key !== undefined
					? `Environment variable "${key}"`
					: "An environment variable";
		return `${subject} is undefined — its value (typically a \`process.env.*\`) is unset. Set it (e.g. add it to your .env) or provide a fallback like \`process.env.X ?? ""\`.`;
	},
});

/**
 * Per-function environment map. Every value must be a defined string (see
 * {@link functionEnvValueSchema}): a `process.env.X` that is unset surfaces as `undefined` and
 * is rejected here (rather than silently shipping `undefined` into the deployment).
 */
const functionEnvSchema = z.record(z.string(), functionEnvValueSchema);

/**
 * TCP port for a function's local dev server. Excludes 0 (which means "any port" to the OS
 * — `neon dev` expresses "pick one for me" by omitting `port`, not by passing 0).
 */
const devPortSchema = z.number().int().min(1).max(65535);

/**
 * Local-dev settings for a function (`neon dev` only; never affects deploy). `port` is bound
 * exactly when set (and `neon dev` fails if it is taken), or a free port is found when omitted.
 */
const functionDevConfigSchema = z.strictObject({
	port: devPortSchema.optional(),
});

/**
 * The name of a package the bundler must leave alone. Accepts what esbuild's `external`
 * accepts for a package — a bare name, a scope, or a subpath — and rejects a relative or
 * absolute path, which names a local module rather than a dependency and is never the right
 * thing to externalize (the bundle would ship an import of a file that isn't deployed).
 */
const externalPackageNameSchema = z
	.string()
	.min(1)
	.refine((value) => !value.startsWith(".") && !value.startsWith("/"), {
		error: 'must be a package name such as "microsandbox" or "@scope/pkg", not a relative or absolute path',
	});

/**
 * One entry of `externalPackages`. A bare string is the common case and ships the package's
 * files; the object form exists only to turn that off. See {@link FunctionDef.externalPackages}.
 */
const externalPackageEntrySchema = z.union([
	externalPackageNameSchema,
	z.strictObject({
		name: externalPackageNameSchema,
		includeFiles: z.boolean().optional(),
	}),
]);

/**
 * Per-function list of packages esbuild leaves unresolved at deploy time. See
 * {@link FunctionDef.externalPackages}.
 */
const functionExternalPackagesSchema = z.array(externalPackageEntrySchema);

const runtimeSchema = z.literal("nodejs24");

/** The declared name of an entry, whichever form it was written in. */
const entryName = (
	entry: z.infer<typeof externalPackageEntrySchema>,
): string => (typeof entry === "string" ? entry : entry.name);

/** Whether an entry ships its files. Absent means yes — see `FunctionDef.externalPackages`. */
const entryIncludesFiles = (
	entry: z.infer<typeof externalPackageEntrySchema>,
): boolean => (typeof entry === "string" ? true : entry.includeFiles !== false);

/**
 * Static definition of a function (existence). The slug is the record key (validated by
 * {@link functionSlugSchema}), so it is not a field here. Deploy tuning (`runtime`) lives
 * in the `branch` closure, not here.
 *
 * `externalPackages` entries are checked for contradictions: the same package named twice,
 * or named once bare and once through a subpath with a different `includeFiles`. Both state
 * two intents for one package, and files are staged per package rather than per subpath, so
 * neither can be honoured as written.
 */
export const functionDefSchema = z
	.strictObject({
		name: z.string().min(1).max(255),
		source: z.string().min(1),
		env: functionEnvSchema.optional(),
		externalPackages: functionExternalPackagesSchema.optional(),
		dev: functionDevConfigSchema.optional(),
	})
	.check((ctx) => {
		const entries = ctx.value.externalPackages ?? [];
		const seenNames = new Map<string, number>();
		const rootIntent = new Map<
			string,
			{ includeFiles: boolean; at: string }
		>();

		entries.forEach((entry, index) => {
			const name = entryName(entry);
			const includeFiles = entryIncludesFiles(entry);

			const firstIndex = seenNames.get(name);
			if (firstIndex !== undefined) {
				ctx.issues.push({
					code: "custom",
					input: entry,
					path: ["externalPackages", index],
					message: `"${name}" is listed more than once (first at index ${firstIndex})`,
				});
				return;
			}
			seenNames.set(name, index);

			// Files are installed and traced per package, so two specifiers that resolve to the
			// same package cannot disagree about whether that package's files ship.
			const root = externalPackageRoot(name);
			const prior = rootIntent.get(root);
			if (prior !== undefined && prior.includeFiles !== includeFiles) {
				ctx.issues.push({
					code: "custom",
					input: entry,
					path: ["externalPackages", index],
					message:
						`"${name}" and "${prior.at}" are both part of the "${root}" package but disagree ` +
						`about includeFiles; files ship per package, so the whole package either ships or does not`,
				});
				return;
			}
			rootIntent.set(root, { includeFiles, at: name });
		});
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
				const result = parseBranchTtl(value);
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
export const configInputSchema = z
	.strictObject({
		auth: serviceToggleInputSchema.optional(),
		dataApi: dataApiInputSchema.optional(),
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
	})
	.superRefine((cfg, ctx) => {
		// A Data API verified by Neon Auth (`authProvider: "neon"`, the default) needs Neon
		// Auth enabled on the same branch so the tokens it verifies actually exist. Enforce
		// the same invariant the `defineConfig` type-level check expresses, at runtime.
		if (!isToggleEnabledValue(cfg.dataApi)) return;
		if (dataApiAuthProviderValue(cfg.dataApi) !== "neon") return;
		if (!isToggleEnabledValue(cfg.auth)) {
			ctx.addIssue({
				code: "custom",
				path: ["auth"],
				message:
					'dataApi with authProvider "neon" requires Neon Auth — set `auth: true` (or `auth: { enabled: true }`), or use `dataApi.authProvider: "external"` with your own `jwksUrl`.',
			});
		}
	});

/**
 * Whether a parsed `auth` / `dataApi` toggle value is enabled: a present object (or `true`)
 * is on unless `enabled` is explicitly `false`. Mirrors `isServiceEnabled` in
 * `define-config.ts`, operating on the already-validated runtime value.
 */
function isToggleEnabledValue(value: unknown): boolean {
	if (value === undefined || value === null) return false;
	if (typeof value === "boolean") return value;
	if (typeof value === "object") {
		return (value as { enabled?: unknown }).enabled !== false;
	}
	return false;
}

/** Read the (defaulted) `authProvider` from a parsed `dataApi` value. */
function dataApiAuthProviderValue(value: unknown): "neon" | "external" {
	if (value !== null && typeof value === "object") {
		const provider = (value as { authProvider?: unknown }).authProvider;
		if (provider === "external") return "external";
	}
	return "neon";
}

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
		const keys = issue.keys ?? [];
		const formatted = keys.map((k) => JSON.stringify(k)).join(", ");
		return `unknown key${keys.length === 1 ? "" : "s"}: ${formatted}`;
	}
	if (issue.code === "invalid_key") {
		// A record *key* that fails its key schema (e.g. a bad function slug) surfaces in
		// zod as a single `invalid_key` issue whose own `message` is the generic, useless
		// "Invalid key in record". The actual reason — the function-slug regex rule, say —
		// lives in the nested key-schema `issues`. Hoist those so the user sees *why* the
		// key was rejected (the offending key itself is already in the issue `path`).
		const reasons = issue.issues
			.map((nested) => nested.message)
			.filter((message) => message.length > 0);
		if (reasons.length > 0) return reasons.join("; ");
	}
	return issue.message;
}
