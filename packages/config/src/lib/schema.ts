import { z } from "zod";
import {
	customDomainValidationError,
	normalizeCustomDomain,
} from "./custom-domain.js";
import { parseBranchTtl, parseSuspendTimeout } from "./duration.js";
import { externalPackageRoot } from "./external-packages.js";
import { isWildcardPattern, validatePattern } from "./patterns.js";
import { COMPUTE_UNITS, type FunctionBundlerInput } from "./types.js";

/** Autoscaling max from the compute size table; larger sizes are fixed-size only. */
const AUTOSCALING_MAX_CU = 16;
/** Documented ceiling on `max - min` when both bounds are set and differ. */
const AUTOSCALING_MAX_RANGE_CU = 8;

const computeUnitSchema = z.literal(COMPUTE_UNITS, {
	error: (issue) =>
		`must be a compute size Neon offers: 0.25, 0.5, an integer 1-16, or an even integer 18-56 (got ${JSON.stringify(issue.input)})`,
});

/**
 * Zod schema for {@link import("./types.js").ComputeSettings}.
 *
 * CU values come from {@link COMPUTE_UNITS} (the Console size table). Plan limits are
 * the API's job. Cross-field autoscaling rules apply only when both bounds are set:
 * `min <= max`; if they differ, each bound is ≤ 16 and `max - min` ≤ 8. A single bound
 * cannot be checked against those rules because the other end is the project's default.
 *
 * `suspendTimeout` can be:
 *   - `false` (never suspend)
 *   - duration string like "5m", "1h" (must be 60s-604800s when parsed)
 *   - number in seconds (60-604800, or -1/0 for special values)
 *   - `undefined` (use platform default)
 */
export const computeSettingsSchema = z
	.strictObject({
		autoscalingLimitMinCu: computeUnitSchema.optional(),
		autoscalingLimitMaxCu: computeUnitSchema.optional(),
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
		if (min === undefined || max === undefined) return;
		if (min > max) {
			ctx.addIssue({
				code: "custom",
				path: ["autoscalingLimitMinCu"],
				message: `autoscalingLimitMinCu (${min}) must be <= autoscalingLimitMaxCu (${max})`,
			});
			return;
		}
		if (min === max) return;
		const overMaxMessage = (field: string, value: number) =>
			`${field} (${value}) exceeds the autoscaling maximum of ${AUTOSCALING_MAX_CU} CU — sizes above ${AUTOSCALING_MAX_CU} are fixed-size only (set autoscalingLimitMinCu = autoscalingLimitMaxCu)`;
		if (min > AUTOSCALING_MAX_CU) {
			ctx.addIssue({
				code: "custom",
				path: ["autoscalingLimitMinCu"],
				message: overMaxMessage("autoscalingLimitMinCu", min),
			});
		}
		if (max > AUTOSCALING_MAX_CU) {
			ctx.addIssue({
				code: "custom",
				path: ["autoscalingLimitMaxCu"],
				message: overMaxMessage("autoscalingLimitMaxCu", max),
			});
		}
		if (max - min > AUTOSCALING_MAX_RANGE_CU) {
			ctx.addIssue({
				code: "custom",
				path: ["autoscalingLimitMaxCu"],
				message: `autoscaling range cannot exceed ${AUTOSCALING_MAX_RANGE_CU} CU: min ${min} to max ${max} is a range of ${max - min}`,
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
 * Used as the **key schema** of the `functions` record, so a bad slug fails
 * validation with a path pointing at the offending key and duplicate slugs are impossible
 * by construction (object keys are unique).
 */
const functionSlugSchema = z
	.string()
	.regex(
		/^[a-z0-9]{1,20}$/,
		"function slug must be 1-20 lowercase letters and digits (no hyphens or other characters)",
	);

/** Bucket name: 1–255 chars. Used as the key schema of the `buckets` record. */
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
		return `${subject} is undefined — its value (typically a \`process.env.*\`) is unset. Set it (for example \`neon deploy --env <file>\`) or omit the key from neon.ts if you do not want to write it. Do not coerce a missing value to an empty string: that uploads and deletes the live key.`;
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

const functionScheduleTriggerSchema = z.strictObject({
	type: z.literal("schedule"),
	function: functionSlugSchema,
	cron: z.string().min(1),
	functionPath: z.string().min(1).optional(),
	enabled: z.boolean().optional(),
});

const functionStorageObjectCreatedTriggerSchema = z.strictObject({
	type: z.literal("storage_object_created"),
	function: functionSlugSchema,
	bucket: bucketNameSchema,
	prefix: z.string().min(1).max(1024).optional(),
	functionPath: z.string().min(1).optional(),
	enabled: z.boolean().optional(),
});

const functionTriggerSchema = z.discriminatedUnion("type", [
	functionScheduleTriggerSchema,
	functionStorageObjectCreatedTriggerSchema,
]);

const triggerNameSchema = z.string().min(1).max(255);

const triggersRecordSchema = z.record(triggerNameSchema, functionTriggerSchema);

const customDomainSchema = z.string().superRefine((value, ctx) => {
	const message = customDomainValidationError(value);
	if (message) {
		ctx.addIssue({ code: "custom", message });
	}
});

const customDomainsSchema = z
	.array(customDomainSchema)
	.superRefine((domains, ctx) => {
		const seen = new Set<string>();
		for (const [index, domain] of domains.entries()) {
			const normalized = normalizeCustomDomain(domain);
			if (seen.has(normalized)) {
				ctx.addIssue({
					code: "custom",
					path: [index],
					message: `custom domain "${normalized}" is listed more than once`,
				});
				continue;
			}
			seen.add(normalized);
		}
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
 * An entry whose files are staged has to name one installable package, because the deploy
 * hands its root to `npm install`. esbuild's `external` additionally accepts a `*` wildcard
 * and a bare scope, which name a set rather than a package — legal only when nothing is
 * being installed for them.
 */
const stageablePackageName = (value: string): boolean => {
	// A protocol (`node:fs`, `npm:pkg`) is a specifier, not something to install.
	if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return false;
	// An empty segment (`foo//bar`) or a traversal is not a subpath the deploy can act on.
	const segments = value.split("/");
	if (segments.some((segment) => segment === "" || segment === "..")) {
		return false;
	}
	return isNpmPackageName(externalPackageRoot(value));
};

/**
 * npm's own rules for a package name, which is what the deploy hands to `npm install`.
 * Deliberately strict: whatever slips through here becomes a subprocess argument.
 */
const NPM_NAME_SEGMENT = /^[a-z0-9~][a-z0-9._~-]*$/;

const isNpmPackageName = (root: string): boolean => {
	if (root.length === 0 || root.length > 214) return false;
	if (!root.startsWith("@")) return NPM_NAME_SEGMENT.test(root);
	const [scope, name, ...rest] = root.slice(1).split("/");
	// A bare scope names every package in it, not one package.
	if (rest.length > 0 || name === undefined) return false;
	return NPM_NAME_SEGMENT.test(scope) && NPM_NAME_SEGMENT.test(name);
};

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

const bundlerSchema = z.custom<FunctionBundlerInput>(
	(value) =>
		value === "esbuild" || value === "none" || typeof value === "function",
	{
		message:
			'bundler must be "esbuild", "none", or a function (fn) => Promise<FunctionBundle>',
	},
);

const isEsbuildBundler = (
	bundler: z.infer<typeof bundlerSchema> | undefined,
): boolean => bundler === undefined || bundler === "esbuild";

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
		bundler: bundlerSchema.optional(),
		dev: functionDevConfigSchema.optional(),
		customDomains: customDomainsSchema.optional(),
	})
	.check((ctx) => {
		const entries = ctx.value.externalPackages ?? [];

		// Other bundlers own their output, so `externalPackages` would be ignored.
		if (
			ctx.value.externalPackages !== undefined &&
			!isEsbuildBundler(ctx.value.bundler)
		) {
			ctx.issues.push({
				code: "custom",
				input: ctx.value.externalPackages,
				path: ["externalPackages"],
				message: `externalPackages only applies to the "esbuild" bundler; the "${
					typeof ctx.value.bundler === "function"
						? "custom"
						: ctx.value.bundler
				}" bundler controls its own output. Remove externalPackages or switch to the esbuild bundler`,
			});
			return;
		}

		const seenNames = new Map<string, number>();
		const rootIntent = new Map<
			string,
			{ includeFiles: boolean; at: string }
		>();

		entries.forEach((entry, index) => {
			const name = entryName(entry);
			const includeFiles = entryIncludesFiles(entry);

			if (includeFiles && !stageablePackageName(name)) {
				ctx.issues.push({
					code: "custom",
					input: entry,
					path: ["externalPackages", index],
					message:
						`"${name}" does not name a single installable package, so its files cannot ` +
						`be staged. Name one package, or set includeFiles: false to leave the ` +
						`import unresolved without shipping anything for it`,
				});
				return;
			}

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

/**
 * Functions record. Used as both top-level `functions` and `preview.functions`
 * so {@link previewInputSchema} (`schemas.preview`) keeps the same validation
 * when parsed on its own.
 */
export const functionsRecordSchema = z.record(
	functionSlugSchema,
	functionDefSchema,
);

/** Static, beta Preview feature set: AI Gateway toggle + functions/buckets records. */
export const previewInputSchema = z.strictObject({
	aiGateway: serviceToggleInputSchema.optional(),
	functions: functionsRecordSchema.optional(),
	buckets: z.record(bucketNameSchema, bucketDefSchema).optional(),
});

/** Per-function deploy tuning returned by the `branch` closure. */
export const functionTuningSchema = z.strictObject({
	runtime: runtimeSchema.optional(),
	customDomains: customDomainsSchema.optional(),
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
		functions: z
			.record(functionSlugSchema, functionTuningSchema)
			.optional(),
		preview: previewTuningSchema.optional(),
	})
	.superRefine((cfg, ctx) => {
		validateParentReference({
			ctx,
			path: ["parent"],
			parent: cfg.parent,
		});
		rejectDuplicateHome(ctx, {
			gaPresent: cfg.functions !== undefined,
			previewPresent: cfg.preview?.functions !== undefined,
			gaPath: "functions",
			previewPath: "preview.functions",
		});
	});

/**
 * A single shell-command hook: a non-empty string, or a non-empty array of non-empty
 * strings run sequentially. Mirrors {@link import("./types.js").ShellHook}.
 */
const shellHookSchema = z.union([
	z.string().min(1, "a shell-command hook must be a non-empty string"),
	z
		.array(
			z.string().min(1, "each shell command must be a non-empty string"),
		)
		.min(1, "a shell-command hook array must have at least one command"),
]);

/**
 * A lifecycle hook value: a function (validated structurally — its argument/return are
 * checked by TypeScript, and at call time by the runtime), or a {@link shellHookSchema}.
 */
const hookValueSchema = z.union([
	z.custom<(...args: unknown[]) => unknown>(
		(value) => typeof value === "function",
		{
			message:
				"a hook must be a function `(ctx) => …` or a shell command string/array",
		},
	),
	shellHookSchema,
]);

/** `before` / `after` pair shared by the `checkout`, `create`, and `deploy` hook phases. */
const hookPhaseSchema = z.strictObject({
	before: hookValueSchema.optional(),
	after: hookValueSchema.optional(),
});

/**
 * Lifecycle hooks block (`hooks.checkout` / `hooks.create` / `hooks.deploy`, each
 * `before` / `after`).
 */
export const hooksSchema = z.strictObject({
	checkout: hookPhaseSchema.optional(),
	create: hookPhaseSchema.optional(),
	deploy: hookPhaseSchema.optional(),
});

/** Experimental (unstable) features block (`experimental.hooks`). Currently just `hooks`. */
export const experimentalInputSchema = z.strictObject({
	hooks: hooksSchema.optional(),
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
		aiGateway: serviceToggleInputSchema.optional(),
		functions: functionsRecordSchema.optional(),
		buckets: z.record(bucketNameSchema, bucketDefSchema).optional(),
		triggers: triggersRecordSchema.optional(),
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
		experimental: experimentalInputSchema.optional(),
	})
	.superRefine((cfg, ctx) => {
		rejectDuplicateHome(ctx, {
			gaPresent: cfg.aiGateway !== undefined,
			previewPresent: cfg.preview?.aiGateway !== undefined,
			gaPath: "aiGateway",
			previewPath: "preview.aiGateway",
		});
		rejectDuplicateHome(ctx, {
			gaPresent: cfg.functions !== undefined,
			previewPresent: cfg.preview?.functions !== undefined,
			gaPath: "functions",
			previewPath: "preview.functions",
		});
		rejectDuplicateHome(ctx, {
			gaPresent: cfg.buckets !== undefined,
			previewPresent: cfg.preview?.buckets !== undefined,
			gaPath: "buckets",
			previewPath: "preview.buckets",
		});
		validateAuthoredTriggers(cfg, ctx);
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

function validateAuthoredTriggers(
	cfg: {
		functions?: Record<string, unknown>;
		buckets?: Record<string, unknown>;
		preview?: {
			functions?: Record<string, unknown>;
			buckets?: Record<string, unknown>;
		};
		triggers?: Record<string, z.infer<typeof functionTriggerSchema>>;
	},
	ctx: z.RefinementCtx,
): void {
	if (cfg.triggers === undefined) return;
	const functions = new Set(
		Object.keys(cfg.functions ?? cfg.preview?.functions ?? {}),
	);
	const buckets = new Set(
		Object.keys(cfg.buckets ?? cfg.preview?.buckets ?? {}),
	);
	for (const [name, trigger] of Object.entries(cfg.triggers)) {
		if (!functions.has(trigger.function)) {
			ctx.addIssue({
				code: "custom",
				path: ["triggers", name, "function"],
				message: `trigger "${name}" references function "${trigger.function}", which is not declared in functions (or preview.functions)`,
			});
		}
		if (
			trigger.type === "storage_object_created" &&
			!buckets.has(trigger.bucket)
		) {
			ctx.addIssue({
				code: "custom",
				path: ["triggers", name, "bucket"],
				message: `trigger "${name}" references bucket "${trigger.bucket}", which is not declared in buckets (or preview.buckets)`,
			});
		}
	}
}

function rejectDuplicateHome(
	ctx: z.RefinementCtx,
	args: {
		gaPresent: boolean;
		previewPresent: boolean;
		gaPath: string;
		previewPath: string;
	},
): void {
	if (!args.gaPresent || !args.previewPresent) return;
	ctx.addIssue({
		code: "custom",
		path: args.gaPath.split("."),
		message: `${args.gaPath} is also declared as ${args.previewPath}. Keep ${args.gaPath} and remove ${args.previewPath}.`,
	});
}

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
