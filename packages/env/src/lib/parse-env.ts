/**
 * `parseEnv` — the synchronous, network-free counterpart to `fetchEnv`: read the Neon env vars
 * already injected into `process.env`, validate them against the policy, and return them in the
 * same namespaced shape.
 *
 * Lives in this package rather than in `@neon-internals/env-core` because nothing else needs
 * it. The `neon` CLI resolves env from the API and injects it; it never reads it back. Keeping
 * it here also keeps `zod` out of that package, and so out of every consumer that bundles it.
 */

import {
	type Config,
	ErrorCode,
	PlatformError,
	type ServiceToggleInput,
} from "@neon/config/v1";
import {
	type FilteredNeonEnv,
	functionBaseUrlKey,
	isFunctionBaseUrlKey,
	NEON_ENV_VAR_KEYS,
	type NeonAiGatewayEnv,
	type NeonAuthEnv,
	type NeonBranchEnv,
	type NeonDataApiEnv,
	type NeonEnv,
	type NeonFunctionUrlEnv,
	type NeonPostgresEnv,
	type NeonStorageEnv,
	parseFunctionBaseUrlKey,
	type SelectableEnvKey,
} from "@neon-internals/env-core/env";
import { z } from "zod";

/** The static `preview.functions` record of a config, or an empty record when absent. */
type PreviewFunctionsOf<C extends Config> =
	NonNullable<C["preview"]> extends {
		functions: infer F;
	}
		? F
		: Record<never, never>;

/** The declared function slugs of a config (record keys), as a string union. */
export type FunctionSlugOf<C extends Config> = Extract<
	keyof PreviewFunctionsOf<C>,
	string
>;

/**
 * Human-readable hint surfaced as the **expected type** of `parseEnv`'s `scope` argument when
 * the policy declares no functions at all. Without it the argument's expected type is the bare
 * `never` {@link FunctionSlugOf} yields, and TypeScript reports the opaque `Type '"x"' is not
 * assignable to type 'never'`; the literal turns that into a sentence naming the fix (and the
 * editor offers it as the single completion, so the empty completion list is explained rather
 * than just empty). Mirrors `NeonAuthRequiredHint` in `@neon/config`.
 */
// Exported (type-only) for the type tests in `env.test-d.ts`; intentionally not re-exported
// from `index.ts`, so it stays an internal implementation detail.
export type NoFunctionScopeHint =
	"this policy declares no `preview.functions`, so there is no function scope to read. Declare the function in `neon.ts` first, or omit the scope to read the branch env";

/**
 * The expected type of `parseEnv`'s function-slug `scope` argument: the caller's inferred slug
 * `S` normally, and the {@link NoFunctionScopeHint} message when the policy declares no
 * functions. Keeping `S` (rather than `FunctionSlugOf<C>`) in the enabled branch is what makes
 * the returned `function` namespace exact — it stays the one function's env keys instead of
 * widening to every declared function's.
 */
type FunctionScopeField<C extends Config, S extends string> = [
	FunctionSlugOf<C>,
] extends [never]
	? NoFunctionScopeHint
	: S;

/** The declared env-var keys of one function `S`, as a string union. */
type FunctionEnvKeysOf<
	C extends Config,
	S extends string,
> = S extends keyof PreviewFunctionsOf<C>
	? NonNullable<PreviewFunctionsOf<C>[S]> extends { env: infer E }
		? Extract<keyof E, string>
		: never
	: never;

/**
 * The extra `function` namespace added to `parseEnv`'s result when called with a function
 * slug scope: the declared env-var keys for that function, each resolved to a `string`.
 */
export type NeonFunctionEnv<C extends Config, S extends string> = {
	function: Record<FunctionEnvKeysOf<C, S>, string>;
};

// ───────────────────────── parseEnv ─────────────────────────

/**
 * Per-namespace zod schemas. Each defines exactly the OS-level keys parsed from
 * `process.env` for its namespace. Keep in sync with {@link NEON_ENV_VAR_KEYS}.
 *
 * `z.string().url()` would be tighter than `min(1)` but Postgres URIs that include
 * URL-illegal characters in the password (rare but legal in Neon's connection-string
 * format) fail the WHATWG `URL` parse, so we settle for "non-empty string".
 */
const postgresEnvSchema = z.object({
	DATABASE_URL: z
		.string({ message: "DATABASE_URL is missing" })
		.min(1, "DATABASE_URL must not be empty"),
	DATABASE_URL_UNPOOLED: z
		.string({ message: "DATABASE_URL_UNPOOLED is missing" })
		.min(1, "DATABASE_URL_UNPOOLED must not be empty"),
});

const authEnvSchema = z.object({
	NEON_AUTH_BASE_URL: z
		.string({ message: "NEON_AUTH_BASE_URL is missing" })
		.min(1, "NEON_AUTH_BASE_URL must not be empty"),
	NEON_AUTH_JWKS_URL: z
		.string({ message: "NEON_AUTH_JWKS_URL is missing" })
		.min(1, "NEON_AUTH_JWKS_URL must not be empty"),
});

const dataApiEnvSchema = z.object({
	NEON_DATA_API_URL: z
		.string({ message: "NEON_DATA_API_URL is missing" })
		.min(1, "NEON_DATA_API_URL must not be empty"),
});

const storageEnvSchema = z.object({
	AWS_ACCESS_KEY_ID: z
		.string({ message: "AWS_ACCESS_KEY_ID is missing" })
		.min(1, "AWS_ACCESS_KEY_ID must not be empty"),
	AWS_SECRET_ACCESS_KEY: z
		.string({ message: "AWS_SECRET_ACCESS_KEY is missing" })
		.min(1, "AWS_SECRET_ACCESS_KEY must not be empty"),
	AWS_ENDPOINT_URL_S3: z
		.string({ message: "AWS_ENDPOINT_URL_S3 is missing" })
		.min(1, "AWS_ENDPOINT_URL_S3 must not be empty"),
	AWS_REGION: z
		.string({ message: "AWS_REGION is missing" })
		.min(1, "AWS_REGION must not be empty"),
});

const aiGatewayEnvSchema = z.object({
	NEON_AI_GATEWAY_TOKEN: z
		.string({ message: "NEON_AI_GATEWAY_TOKEN is missing" })
		.min(1, "NEON_AI_GATEWAY_TOKEN must not be empty"),
	NEON_AI_GATEWAY_BASE_URL: z
		.string({ message: "NEON_AI_GATEWAY_BASE_URL is missing" })
		.min(1, "NEON_AI_GATEWAY_BASE_URL must not be empty"),
});

/** Whether a **static** policy declares object storage (`preview.buckets`). No network. */
function configWantsStorage(config: Config): boolean {
	return Object.keys(config.preview?.buckets ?? {}).length > 0;
}

/** Whether a **static** policy enables the AI Gateway (`preview.aiGateway`). No network. */
function configWantsAiGateway(config: Config): boolean {
	return isServiceEnabledInput(config.preview?.aiGateway);
}

/** Static-toggle helper mirroring `config`'s `isServiceEnabled` for the env reader. */
function isServiceEnabledInput(
	toggle: ServiceToggleInput | undefined,
): boolean {
	if (toggle === undefined) return false;
	if (typeof toggle === "boolean") return toggle;
	return toggle.enabled !== false;
}

/**
 * Synchronous, network-free counterpart to {@link fetchEnv}. Reads `process.env`, validates
 * the required Neon env vars with zod, and returns the same {@link NeonEnv} shape — so the
 * rest of your app touches `env.postgres.databaseUrl` instead of stringly-typed
 * `process.env.DATABASE_URL` lookups.
 *
 * Designed for the **"env-vars-already-injected"** path:
 * - You wrapped your dev command with `neon-env run -- <cmd>` or `neon dev`.
 * - Your platform (Vercel, Fly, Railway, …) injected the vars via its own integration.
 * - You are **inside a deployed Neon Function**, whose env was uploaded at `config apply`.
 *
 * Unlike the old API, `parseEnv` does **not** take a branch name: the secret set is now
 * static (top-level `config.auth` / `config.dataApi`), so it reads those directly without
 * evaluating the per-branch closure.
 *
 * The second argument is a **scope** or a **key filter**:
 * - omitted — *external* scope (app bootstrap, build scripts, your dev machine). Returns the
 *   full `{ postgres, auth?, dataApi?, … }` the policy enables.
 * - a **function slug** (a key of `config.preview.functions`) — *function* scope: you are
 *   running inside that function. Returns the same branch secrets **plus** a typed
 *   `function` namespace with the function's declared env-var keys. The slug autocompletes
 *   from the policy ({@link FunctionSlugOf}) and an undeclared one is a type error.
 * - an **array of OS-level env-var keys** (e.g. `["DATABASE_URL", "NEON_AUTH_BASE_URL"]`) —
 *   *filtered* mode: only those vars are required and returned, as a narrowed namespaced
 *   shape. The keys autocomplete from the policy ({@link SelectableEnvKey}), so you can only
 *   pick vars the policy actually enables. Use this when a process needs just a subset (a
 *   Next.js app that reads `DATABASE_URL` but not `DATABASE_URL_UNPOOLED`, say) and you don't
 *   want `parseEnv` to throw over vars you never use.
 *
 * Throws `PlatformError(EnvNotInjected)` listing every missing/invalid var when the env
 * isn't fully populated, with a fix hint pointing back at `neon dev` / `neon-env run`.
 *
 * ```ts
 * import config from "../neon";
 * import { parseEnv } from "@neon/env";
 *
 * // External (app / build):
 * const env = parseEnv(config);
 * const db = drizzle(neon(env.postgres.databaseUrl), { schema });
 *
 * // Inside the "hello" function:
 * const env = parseEnv(config, "hello");
 * env.function.resendApiKey; // typed from hello's declared env keys
 *
 * // Filtered: only enforce + return the pooled URL.
 * const { postgres } = parseEnv(config, ["DATABASE_URL"]);
 * postgres.databaseUrl; // string — `databaseUrlUnpooled` is absent
 * ```
 */
export function parseEnv<const C extends Config>(config: C): NeonEnv<C>;
// Overload order is load-bearing for **editor autocomplete**, not for type checking: when the
// argument is a half-typed string literal the call resolves against no signature, and the
// editor takes its string-literal completions from the first candidate overload. With the
// `keys` overload listed first, the expected type of `parseEnv(config, "…")` is read as
// `readonly K[]` — an array has no literal completions, so typing a function slug offered
// nothing. Keep the slug overload ahead of the array one: `env.completions.test.ts` asserts the
// completions through the language service, and `env.test-d.ts` locks the order itself (the
// last overload is observable as `Parameters<typeof parseEnv>`), so `tsc` fails on a reorder.
export function parseEnv<
	const C extends Config,
	const S extends FunctionSlugOf<C>,
>(
	config: C,
	scope: FunctionScopeField<C, S>,
): NeonEnv<C> & NeonFunctionEnv<C, S>;
export function parseEnv<
	const C extends Config,
	const K extends SelectableEnvKey<C>,
>(config: C, keys: readonly K[]): FilteredNeonEnv<K>;
export function parseEnv(
	config: Config,
	scopeOrKeys?: string | readonly string[],
): unknown {
	const source = process.env;
	if (Array.isArray(scopeOrKeys)) {
		return parseFilteredEnv(source, scopeOrKeys);
	}
	// `Array.isArray` doesn't narrow a `readonly string[]` out of the union, so re-derive the
	// function-slug scope from the remaining `string` shape explicitly.
	const scope = typeof scopeOrKeys === "string" ? scopeOrKeys : undefined;
	const issues: string[] = [];
	const result: Record<string, unknown> = {};

	const pg = postgresEnvSchema.safeParse({
		DATABASE_URL: source.DATABASE_URL,
		DATABASE_URL_UNPOOLED: source.DATABASE_URL_UNPOOLED,
	});
	if (pg.success) {
		result.postgres = {
			databaseUrl: pg.data.DATABASE_URL,
			databaseUrlUnpooled: pg.data.DATABASE_URL_UNPOOLED,
		} satisfies NeonPostgresEnv;
	} else {
		for (const issue of pg.error.issues) issues.push(issue.message);
	}

	// Branch identity is optional: the Functions runtime injects `NEON_BRANCH` on every
	// branch by default and `neon dev` / `neon-env run` / `env pull` emit it too, but older
	// runtimes and platform integrations may not, so a missing value is not an error — we
	// just omit the namespace rather than failing the whole parse.
	const branchName = source[NEON_ENV_VAR_KEYS.branch.name];
	if (branchName !== undefined && branchName !== "") {
		result.branch = { name: branchName } satisfies NeonBranchEnv;
	}

	if (isServiceEnabledInput(config.auth)) {
		const auth = authEnvSchema.safeParse({
			NEON_AUTH_BASE_URL: source.NEON_AUTH_BASE_URL,
			NEON_AUTH_JWKS_URL: source.NEON_AUTH_JWKS_URL,
		});
		if (auth.success) {
			result.auth = {
				baseUrl: auth.data.NEON_AUTH_BASE_URL,
				jwksUrl: auth.data.NEON_AUTH_JWKS_URL,
			} satisfies NeonAuthEnv;
		} else {
			for (const issue of auth.error.issues) issues.push(issue.message);
		}
	}

	if (isServiceEnabledInput(config.dataApi)) {
		const dataApi = dataApiEnvSchema.safeParse({
			NEON_DATA_API_URL: source.NEON_DATA_API_URL,
		});
		if (dataApi.success) {
			result.dataApi = {
				url: dataApi.data.NEON_DATA_API_URL,
			} satisfies NeonDataApiEnv;
		} else {
			for (const issue of dataApi.error.issues)
				issues.push(issue.message);
		}
	}

	if (configWantsStorage(config)) {
		const storage = storageEnvSchema.safeParse({
			AWS_ACCESS_KEY_ID: source.AWS_ACCESS_KEY_ID,
			AWS_SECRET_ACCESS_KEY: source.AWS_SECRET_ACCESS_KEY,
			AWS_ENDPOINT_URL_S3: source.AWS_ENDPOINT_URL_S3,
			AWS_REGION: source.AWS_REGION,
		});
		if (storage.success) {
			result.storage = {
				accessKeyId: storage.data.AWS_ACCESS_KEY_ID,
				secretAccessKey: storage.data.AWS_SECRET_ACCESS_KEY,
				endpoint: storage.data.AWS_ENDPOINT_URL_S3,
				region: storage.data.AWS_REGION,
			} satisfies NeonStorageEnv;
		} else {
			for (const issue of storage.error.issues)
				issues.push(issue.message);
		}
	}

	if (configWantsAiGateway(config)) {
		const aiGateway = aiGatewayEnvSchema.safeParse({
			NEON_AI_GATEWAY_TOKEN: source.NEON_AI_GATEWAY_TOKEN,
			NEON_AI_GATEWAY_BASE_URL: source.NEON_AI_GATEWAY_BASE_URL,
		});
		if (aiGateway.success) {
			result.aiGateway = {
				apiKey: aiGateway.data.NEON_AI_GATEWAY_TOKEN,
				baseUrl: aiGateway.data.NEON_AI_GATEWAY_BASE_URL,
			} satisfies NeonAiGatewayEnv;
		} else {
			for (const issue of aiGateway.error.issues)
				issues.push(issue.message);
		}
	}

	const declaredFunctionSlugs = Object.keys(
		config.preview?.functions ?? {},
	).sort();
	if (declaredFunctionSlugs.length > 0) {
		const functions: Record<string, NeonFunctionUrlEnv> = {};
		for (const slug of declaredFunctionSlugs) {
			const key = functionBaseUrlKey(slug);
			const value = source[key];
			if (value === undefined) {
				issues.push(`${key} is missing`);
			} else if (value === "") {
				issues.push(`${key} must not be empty`);
			} else {
				functions[slug] = { baseUrl: value };
			}
		}
		if (Object.keys(functions).length === declaredFunctionSlugs.length) {
			result.functions = functions;
		}
	}

	if (scope !== undefined) {
		const fn = config.preview?.functions?.[scope];
		if (!fn) {
			throw new PlatformError(
				ErrorCode.EnvNotInjected,
				[
					`parseEnv: no function "${scope}" is declared in this policy's preview.functions.`,
					"Pass a declared function slug (or omit the scope to read external env).",
				].join("\n"),
				{ details: { scope } },
			);
		}
		const envOut: Record<string, string> = {};
		for (const key of Object.keys(fn.env ?? {})) {
			const value = source[key];
			// Only a truly *unset* var is "not injected". Function env values carry no
			// non-empty constraint (unlike DATABASE_URL / NEON_AUTH_BASE_URL), so a
			// deliberately empty value is a present, valid value and is passed through.
			if (value === undefined) {
				issues.push(`${key} is missing (function "${scope}")`);
			} else {
				envOut[key] = value;
			}
		}
		result.function = envOut;
	}

	if (issues.length > 0) {
		throw new PlatformError(
			ErrorCode.EnvNotInjected,
			[
				"parseEnv: the required Neon env variables are not present in process.env.",
				...issues.map((i) => `  - ${i}`),
				"Inject them via one of:",
				"  - `neon dev` / `neon-env run -- <your dev command>` (wraps the command with the vars injected)",
				"  - your hosting platform's Neon integration (Vercel, Fly, Railway, …)",
				"  - for the `function` namespace: deploy the function (`neon deploy` / `config apply`) so its env is uploaded.",
				"Or switch the call to `await fetchEnv(config, …)` if you're in a context that can do async I/O.",
			].join("\n"),
			{ details: { missing: issues } },
		);
	}

	return result;
}

/**
 * Runtime reverse map for filtered `parseEnv`: OS-level env-var key → `[namespace, property]`
 * in the {@link NeonEnv} shape. The compile-time mirror is {@link EnvKeysByNamespace} /
 * {@link EnvKeyToProp}; keep all three in sync. Only input vars appear (no output-only
 * aliases).
 */
const FILTERABLE_ENV_KEYS: Record<string, readonly [string, string]> = {
	DATABASE_URL: ["postgres", "databaseUrl"],
	DATABASE_URL_UNPOOLED: ["postgres", "databaseUrlUnpooled"],
	NEON_BRANCH: ["branch", "name"],
	NEON_AUTH_BASE_URL: ["auth", "baseUrl"],
	NEON_AUTH_JWKS_URL: ["auth", "jwksUrl"],
	NEON_DATA_API_URL: ["dataApi", "url"],
	AWS_ACCESS_KEY_ID: ["storage", "accessKeyId"],
	AWS_SECRET_ACCESS_KEY: ["storage", "secretAccessKey"],
	AWS_ENDPOINT_URL_S3: ["storage", "endpoint"],
	AWS_REGION: ["storage", "region"],
	NEON_AI_GATEWAY_TOKEN: ["aiGateway", "apiKey"],
	NEON_AI_GATEWAY_BASE_URL: ["aiGateway", "baseUrl"],
};

/**
 * Filtered counterpart to the {@link parseEnv} body: validate and return only the explicitly
 * selected OS-level env-var keys, projected back into the narrowed namespaced shape. Unlike
 * the full reader it never consults the policy — the selection alone decides what's required —
 * so vars the caller didn't ask for (e.g. `DATABASE_URL_UNPOOLED`) can be absent without
 * throwing. Mirrors the same non-empty constraint and {@link PlatformError} aggregation.
 */
function parseFilteredEnv(
	source: NodeJS.ProcessEnv,
	keys: readonly string[],
): Record<string, unknown> {
	const issues: string[] = [];
	const result: Record<string, Record<string, unknown>> = {};
	const functionUrls: Record<string, NeonFunctionUrlEnv> = {};
	for (const key of keys) {
		if (isFunctionBaseUrlKey(key)) {
			const slug = parseFunctionBaseUrlKey(key);
			if (slug === null) continue;
			const value = source[key];
			if (value === undefined) {
				issues.push(`${key} is missing`);
				continue;
			}
			if (value === "") {
				issues.push(`${key} must not be empty`);
				continue;
			}
			functionUrls[slug] = { baseUrl: value };
			continue;
		}
		// Unknown keys are blocked at the type level; a runtime caller bypassing the types
		// gets a clear error rather than a silently-dropped selection.
		if (!Object.hasOwn(FILTERABLE_ENV_KEYS, key)) {
			issues.push(`${key} is not a selectable Neon env variable`);
			continue;
		}
		const value = source[key];
		if (value === undefined) {
			issues.push(`${key} is missing`);
			continue;
		}
		if (value === "") {
			issues.push(`${key} must not be empty`);
			continue;
		}
		const [namespace, property] = FILTERABLE_ENV_KEYS[key];
		const bucket = result[namespace] ?? {};
		bucket[property] = value;
		result[namespace] = bucket;
	}
	if (Object.keys(functionUrls).length > 0) {
		result.functions = functionUrls;
	}
	if (issues.length > 0) {
		throw new PlatformError(
			ErrorCode.EnvNotInjected,
			[
				"parseEnv: the required Neon env variables are not present in process.env.",
				...issues.map((i) => `  - ${i}`),
				"Inject them via one of:",
				"  - `neon dev` / `neon-env run -- <your dev command>` (wraps the command with the vars injected)",
				"  - your hosting platform's Neon integration (Vercel, Fly, Railway, …)",
				"Or switch the call to `await fetchEnv(config, …)` if you're in a context that can do async I/O.",
			].join("\n"),
			{ details: { missing: issues } },
		);
	}
	return result;
}
