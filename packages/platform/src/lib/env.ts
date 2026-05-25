import { z } from "zod";
import { createNeonApiFromOptions } from "./auth.js";
import { resolveConfig } from "./define-config.js";
import { ErrorCode, PlatformError } from "./errors.js";
import { type BranchRef, loadContext } from "./load-context.js";
import type {
	NeonApi,
	NeonBranchSnapshot,
	NeonDatabaseSnapshot,
	NeonRoleSnapshot,
} from "./neon-api.js";
import type { BranchConfig, Config } from "./types.js";

/**
 * Mapping between the {@link NeonEnv} property paths and the OS-level env-var keys used
 * for cross-process transport (via `.env` files, `env run -- <cmd>`, or anything else
 * that talks to `process.env`).
 *
 * Each top-level key here is a {@link NeonEnv} namespace; the inner record maps the
 * camelCase property names exposed to TypeScript to the UPPER_SNAKE env-var names used
 * by the OS. Keep this in sync with {@link postgresEnvSchema} / {@link authEnvSchema} /
 * {@link dataApiEnvSchema}.
 */
export const NEON_ENV_VAR_KEYS = {
	postgres: {
		databaseUrl: "DATABASE_URL",
		databaseUrlUnpooled: "DATABASE_URL_UNPOOLED",
	},
	auth: {
		projectId: "NEON_AUTH_PROJECT_ID",
		publishableClientKey: "NEON_AUTH_PUBLISHABLE_CLIENT_KEY",
		secretServerKey: "NEON_AUTH_SECRET_SERVER_KEY",
		jwksUrl: "NEON_AUTH_JWKS_URL",
	},
	dataApi: {
		url: "NEON_DATA_API_URL",
	},
} as const;

/** Per-namespace inner shapes. Exposed so consumers can name the parts independently. */
export interface NeonPostgresEnv {
	/**
	 * Pooled connection string (via Neon's PgBouncer pooler). The right default for
	 * serverless drivers (`@neondatabase/serverless`, edge runtimes, Postgres.js, …).
	 */
	databaseUrl: string;
	/**
	 * Direct (unpooled) connection string. Use this when you need session-level
	 * features (`LISTEN`/`NOTIFY`, prepared statements across calls, transactions
	 * spanning round-trips) that PgBouncer's transaction-mode pooling drops.
	 */
	databaseUrlUnpooled: string;
}

/**
 * Public + secret bits of a Neon Auth integration for the resolved branch. Only present
 * on `NeonEnv` when the branch policy enables `auth`.
 *
 * `projectId` / `jwksUrl` are fetchable via `getNeonAuth`. The two key fields
 * (`publishableClientKey`, `secretServerKey`) are *not* refetchable after integration
 * creation — `fetchEnv` reads them from `process.env`, `parseEnv` always does. Pull them
 * once at create time (via the Neon Console / `neonctl auth …`) and feed them through
 * your secret-management of choice.
 */
export interface NeonAuthEnv {
	projectId: string;
	publishableClientKey: string;
	secretServerKey: string;
	jwksUrl: string;
}

/** Bits of a Neon Data API integration. Only present when the branch policy enables it. */
export interface NeonDataApiEnv {
	url: string;
}

/**
 * Static, namespaced shape of `fetchEnv` / `parseEnv`'s return value. Generic over the
 * {@link Config} so the type system knows which optional namespaces are present.
 *
 * - `postgres` is always present.
 * - `auth` is added iff the config return type has an `auth` namespace that is not
 *   explicitly disabled.
 * - `dataApi` is added iff the config return type has a `dataApi` namespace that is not
 *   explicitly disabled.
 */
/**
 * Empty record alias used as the "false" branch of the conditional namespace adds below.
 * `Record<never, never>` is the no-op for intersection — the cleaner alternative to `{}`,
 * which biome rejects (it means "any non-null", not "empty object").
 */
type NoNamespace = Record<never, never>;

type BranchConfigOf<C extends Config> = ReturnType<C> extends BranchConfig
	? ReturnType<C>
	: BranchConfig;

type FeatureEnabledConfig<
	Cfg,
	Key extends "auth" | "dataApi",
> = Cfg extends Record<Key, infer Toggle>
	? Toggle extends { enabled: false }
		? never
		: Cfg
	: never;

type HasEnabledFeature<Cfg, Key extends "auth" | "dataApi"> = [
	FeatureEnabledConfig<Cfg, Key>,
] extends [never]
	? false
	: true;

export type NeonEnv<C extends Config = Config> = {
	postgres: NeonPostgresEnv;
} & (HasEnabledFeature<BranchConfigOf<C>, "auth"> extends true
	? { auth: NeonAuthEnv }
	: NoNamespace) &
	(HasEnabledFeature<BranchConfigOf<C>, "dataApi"> extends true
		? { dataApi: NeonDataApiEnv }
		: NoNamespace);

export interface FetchEnvOptions {
	/**
	 * Neon API key. Resolved via {@link resolveApiKey} when omitted (option → env →
	 * `~/.config/neonctl/credentials.json`). Ignored when a custom `api` is supplied.
	 */
	apiKey?: string;
	/**
	 * Inject a custom NeonApi adapter. Primarily used by tests; production callers can rely
	 * on the default real adapter built from `apiKey`.
	 */
	api?: NeonApi;
	/** Explicit project id. Overrides `NEON_PROJECT_ID` and `.neon[/project.json]`. */
	projectId?: string;
	/**
	 * Explicit branch id (`br-…`) or branch name. Resolution chain:
	 * `options.branch` → `NEON_BRANCH_ID` env → context file → project default branch.
	 */
	branch?: string;
	/**
	 * Role name to fetch credentials for. When omitted, the only role on the branch is
	 * auto-picked; throws {@link PlatformError} with `PLATFORM_AMBIGUOUS_BRANCH_AUTH` if
	 * the branch has more than one role.
	 */
	roleName?: string;
	/**
	 * Database name. When omitted, the only database on the branch is auto-picked; throws
	 * {@link PlatformError} with `PLATFORM_AMBIGUOUS_BRANCH_AUTH` if the branch has more
	 * than one database.
	 */
	databaseName?: string;
	/** Starting directory for the context-file search. Defaults to `process.cwd()`. */
	cwd?: string;
}

/**
 * Resolve the project + branch this process should target, then fetch live Neon
 * connection strings for that branch over the network. Async — calls the Neon API.
 *
 * Use this from build scripts and the `neon-ts env pull` / `env run` commands, where
 * top-level await is fine. For application code that needs a synchronous bootstrap (most
 * frameworks: Drizzle config, Next.js, Vite, etc.), inject env vars via
 * `neon-ts env run -- <cmd>` (or pull them into `.env.local` via `neon-ts env pull`) and
 * use {@link parseEnv} instead — same {@link NeonEnv} shape, but a sync call against
 * `process.env`.
 *
 * ```ts
 * import config from "../neon";
 * import { fetchEnv } from "@neondatabase/platform/v1";
 *
 * const env = await fetchEnv(config);
 * const db = drizzle(neon(env.postgres.databaseUrl), { schema });
 * ```
 *
 * Resolution chain — each entry wins over the next:
 *
 * | Field          | 1st (call args)       | 2nd (env vars)    | 3rd (`.neon/project.json`) | 4th (`.neon` file) | 5th (config)                  |
 * | -------------- | --------------------- | ----------------- | -------------------------- | ------------------ | ----------------------------- |
 * | `projectId`    | `options.projectId`   | `NEON_PROJECT_ID` | `projectId`                | `projectId`        | — (throws if unresolved)      |
 * | `branch`       | `options.branch`      | `NEON_BRANCH_ID`  | `branchId`                 | `branchId`         | project default branch        |
 * | `roleName`     | `options.roleName`    | —                 | —                          | —                  | auto-pick if branch has one   |
 * | `databaseName` | `options.databaseName`| —                 | —                          | —                  | auto-pick if branch has one   |
 *
 * The package does **not** mutate `process.env` or the filesystem itself.
 */
export async function fetchEnv<const C extends Config>(
	config: C,
	options: FetchEnvOptions = {},
): Promise<NeonEnv<C>> {
	const api = options.api ?? createApiFromOptions(options);

	const ctx = loadContext({
		...(options.projectId ? { projectId: options.projectId } : {}),
		...(options.branch ? { branch: options.branch } : {}),
		...(options.cwd ? { cwd: options.cwd } : {}),
	});

	const branches = await api.listBranches(ctx.projectId);
	if (branches.length === 0) {
		throw new PlatformError(
			ErrorCode.BranchNotFound,
			[
				`fetchEnv: project ${ctx.projectId} has no branches.`,
				"Either run `pushConfig()` (or `neon-ts push`) to provision the project from your `neon.ts`, or pick a different project id.",
			].join(" "),
			{ details: { projectId: ctx.projectId } },
		);
	}

	const branch = resolveBranch(ctx.branch, branches);
	const desired = resolveConfig(config, {
		name: branch.name,
		id: branch.id,
		exists: true,
		...(branch.parentId ? { parentId: branch.parentId } : {}),
		isDefault: branch.isDefault,
		isProtected: branch.protected,
		...(branch.expiresAt ? { expiresAt: branch.expiresAt } : {}),
	});

	const [roles, databases] = await Promise.all([
		api.listBranchRoles(ctx.projectId, branch.id),
		api.listBranchDatabases(ctx.projectId, branch.id),
	]);

	const roleName = pickRoleName(roles, branch, options.roleName);
	const databaseName = pickDatabaseName(
		databases,
		branch,
		roleName,
		options.databaseName,
	);

	// Fan out: always fetch both Postgres URIs. Conditionally fetch auth + dataApi based
	// on the branch policy. Auth secret keys aren't fetchable post-create (Neon's API only
	// returns them at integration creation / rotation) so we read those from the env.
	const wantsAuth = desired.authEnabled;
	const wantsDataApi = desired.dataApiEnabled;

	const [pooled, unpooled, authSnapshot, dataApiSnapshot] = await Promise.all(
		[
			api.getConnectionUri(ctx.projectId, {
				branchId: branch.id,
				databaseName,
				roleName,
				pooled: true,
			}),
			api.getConnectionUri(ctx.projectId, {
				branchId: branch.id,
				databaseName,
				roleName,
				pooled: false,
			}),
			wantsAuth
				? api.getNeonAuth(ctx.projectId, branch.id)
				: Promise.resolve(null),
			wantsDataApi
				? api.getNeonDataApi(ctx.projectId, branch.id, databaseName)
				: Promise.resolve(null),
		],
	);

	const result: Record<string, unknown> = {
		postgres: {
			databaseUrl: pooled.uri,
			databaseUrlUnpooled: unpooled.uri,
		},
	};

	if (wantsAuth) {
		if (!authSnapshot) {
			throw new PlatformError(
				ErrorCode.NotFound,
				[
					`fetchEnv: branch policy enables auth but no Neon Auth integration is enabled on branch ${branch.name} (${branch.id}).`,
					"Enable it via `npx neon-ts push` (or `npx neonctl platform push`), in the Neon Console, or with `npx neonctl auth …` — then re-run fetchEnv. Or return auth.enabled=false.",
				].join(" "),
				{
					details: { projectId: ctx.projectId, branchId: branch.id },
				},
			);
		}
		const secrets = readAuthSecretsFromEnv();
		result.auth = {
			projectId: authSnapshot.projectId,
			publishableClientKey: secrets.publishableClientKey,
			secretServerKey: secrets.secretServerKey,
			jwksUrl: authSnapshot.jwksUrl,
		} satisfies NeonAuthEnv;
	}

	if (wantsDataApi) {
		if (!dataApiSnapshot) {
			throw new PlatformError(
				ErrorCode.NotFound,
				[
					`fetchEnv: branch policy enables dataApi but no Data API integration is enabled on branch ${branch.name} (${branch.id}) database ${databaseName}.`,
					"Enable it via `npx neon-ts push` (or `npx neonctl platform push`) or in the Neon Console — then re-run fetchEnv. Or return dataApi.enabled=false.",
				].join(" "),
				{
					details: {
						projectId: ctx.projectId,
						branchId: branch.id,
						databaseName,
					},
				},
			);
		}
		result.dataApi = { url: dataApiSnapshot.url } satisfies NeonDataApiEnv;
	}

	return result as NeonEnv<C>;
}

/**
 * Pull the auth secret/publishable key from `process.env`. These two fields aren't
 * fetchable from the Neon API after integration creation, so the user must inject them
 * out-of-band (via `.env`, hosting platform secret manager, etc.). When either is
 * missing we throw the same `EnvNotInjected` error `parseEnv` would.
 */
function readAuthSecretsFromEnv(): {
	publishableClientKey: string;
	secretServerKey: string;
} {
	const pubKey = NEON_ENV_VAR_KEYS.auth.publishableClientKey;
	const secretKey = NEON_ENV_VAR_KEYS.auth.secretServerKey;
	const issues: string[] = [];
	const publishableClientKey = process.env[pubKey];
	const secretServerKey = process.env[secretKey];
	if (!publishableClientKey) issues.push(`${pubKey} is missing`);
	if (!secretServerKey) issues.push(`${secretKey} is missing`);
	if (issues.length > 0) {
		throw new PlatformError(
			ErrorCode.EnvNotInjected,
			[
				"fetchEnv: Neon Auth secrets must be supplied via process.env — they are not refetchable from the Neon API after integration creation.",
				...issues.map((i) => `  - ${i}`),
				"Pull them once via the Neon Console / `npx neonctl auth …`, then inject via your hosting platform or `.env` file.",
			].join("\n"),
			{ details: { missing: issues } },
		);
	}
	return {
		publishableClientKey: publishableClientKey as string,
		secretServerKey: secretServerKey as string,
	};
}

function createApiFromOptions(options: FetchEnvOptions): NeonApi {
	return createNeonApiFromOptions(
		"fetchEnv",
		options.apiKey ? { apiKey: options.apiKey } : {},
	);
}

function resolveBranch(
	requested: BranchRef | undefined,
	branches: NeonBranchSnapshot[],
): NeonBranchSnapshot {
	if (requested) {
		const match = findBranch(branches, requested);
		if (match) return match;
		throw new PlatformError(
			ErrorCode.BranchNotFound,
			[
				`fetchEnv: branch ${describeRef(requested)} not found on project.`,
				`Existing branches: ${branches.map((b) => `${b.name} (${b.id})`).join(", ")}.`,
			].join(" "),
			{
				details: {
					branch: requested,
					available: branches.map((b) => b.name),
				},
			},
		);
	}

	const fallback = branches.find((b) => b.isDefault) ?? branches[0];
	if (!fallback) {
		// listBranches returned [], but the empty-list path above already throws.
		// This is a belt-and-braces guard so the function is total.
		throw new PlatformError(
			ErrorCode.BranchNotFound,
			"fetchEnv: no branches available on the project.",
		);
	}
	return fallback;
}

function findBranch(
	branches: NeonBranchSnapshot[],
	ref: BranchRef,
): NeonBranchSnapshot | undefined {
	if (ref.kind === "id") return branches.find((b) => b.id === ref.value);
	return branches.find((b) => b.name === ref.value);
}

function describeRef(ref: BranchRef): string {
	return `${ref.kind === "id" ? "id" : "name"}=${JSON.stringify(ref.value)}`;
}

function pickRoleName(
	roles: NeonRoleSnapshot[],
	branch: NeonBranchSnapshot,
	requested: string | undefined,
): string {
	if (requested) {
		if (!roles.some((r) => r.name === requested)) {
			throw new PlatformError(
				ErrorCode.BranchNotFound,
				[
					`fetchEnv: role "${requested}" not found on branch ${branch.name} (${branch.id}).`,
					`Existing roles: ${roles.map((r) => r.name).join(", ") || "(none)"}.`,
				].join(" "),
				{
					details: {
						branchId: branch.id,
						roleName: requested,
						availableRoles: roles.map((r) => r.name),
					},
				},
			);
		}
		return requested;
	}
	if (roles.length === 0) {
		throw new PlatformError(
			ErrorCode.BranchNotFound,
			[
				`fetchEnv: branch ${branch.name} (${branch.id}) has no roles.`,
				"Create one via the Neon console or pass `roleName` explicitly.",
			].join(" "),
			{ details: { branchId: branch.id } },
		);
	}
	if (roles.length === 1) return roles[0].name;
	throw new PlatformError(
		ErrorCode.AmbiguousBranchAuth,
		[
			`fetchEnv: branch ${branch.name} (${branch.id}) has ${roles.length} roles; cannot auto-pick.`,
			`Pass \`roleName\` explicitly. Available: ${roles.map((r) => r.name).join(", ")}.`,
		].join(" "),
		{
			details: {
				branchId: branch.id,
				availableRoles: roles.map((r) => r.name),
			},
		},
	);
}

function pickDatabaseName(
	databases: NeonDatabaseSnapshot[],
	branch: NeonBranchSnapshot,
	roleName: string,
	requested: string | undefined,
): string {
	if (requested) {
		if (!databases.some((d) => d.name === requested)) {
			throw new PlatformError(
				ErrorCode.BranchNotFound,
				[
					`fetchEnv: database "${requested}" not found on branch ${branch.name} (${branch.id}).`,
					`Existing databases: ${databases.map((d) => d.name).join(", ") || "(none)"}.`,
				].join(" "),
				{
					details: {
						branchId: branch.id,
						databaseName: requested,
						availableDatabases: databases.map((d) => d.name),
					},
				},
			);
		}
		return requested;
	}
	if (databases.length === 0) {
		throw new PlatformError(
			ErrorCode.BranchNotFound,
			[
				`fetchEnv: branch ${branch.name} (${branch.id}) has no databases.`,
				"Create one via the Neon console or pass `databaseName` explicitly.",
			].join(" "),
			{ details: { branchId: branch.id } },
		);
	}
	if (databases.length === 1) return databases[0].name;

	// Prefer a database owned by the role we're connecting as.
	const owned = databases.filter((d) => d.ownerName === roleName);
	if (owned.length === 1) return owned[0].name;

	throw new PlatformError(
		ErrorCode.AmbiguousBranchAuth,
		[
			`fetchEnv: branch ${branch.name} (${branch.id}) has ${databases.length} databases; cannot auto-pick.`,
			`Pass \`databaseName\` explicitly. Available: ${databases.map((d) => d.name).join(", ")}.`,
		].join(" "),
		{
			details: {
				branchId: branch.id,
				availableDatabases: databases.map((d) => d.name),
			},
		},
	);
}

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
	NEON_AUTH_PROJECT_ID: z
		.string({ message: "NEON_AUTH_PROJECT_ID is missing" })
		.min(1, "NEON_AUTH_PROJECT_ID must not be empty"),
	NEON_AUTH_PUBLISHABLE_CLIENT_KEY: z
		.string({ message: "NEON_AUTH_PUBLISHABLE_CLIENT_KEY is missing" })
		.min(1, "NEON_AUTH_PUBLISHABLE_CLIENT_KEY must not be empty"),
	NEON_AUTH_SECRET_SERVER_KEY: z
		.string({ message: "NEON_AUTH_SECRET_SERVER_KEY is missing" })
		.min(1, "NEON_AUTH_SECRET_SERVER_KEY must not be empty"),
	NEON_AUTH_JWKS_URL: z
		.string({ message: "NEON_AUTH_JWKS_URL is missing" })
		.min(1, "NEON_AUTH_JWKS_URL must not be empty"),
});

const dataApiEnvSchema = z.object({
	NEON_DATA_API_URL: z
		.string({ message: "NEON_DATA_API_URL is missing" })
		.min(1, "NEON_DATA_API_URL must not be empty"),
});

/**
 * Synchronous, network-free counterpart to {@link fetchEnv}. Reads `process.env` (or
 * `options.env`), validates the required Neon env vars with zod, and returns the same
 * {@link NeonEnv} shape — so the rest of your app touches `env.postgres.databaseUrl`
 * instead of stringly-typed `process.env.DATABASE_URL` lookups.
 *
 * Designed for the **"env-vars-already-injected"** path:
 * - You ran `neon-ts env pull` to write `.env.local`, and your framework auto-loads it.
 * - You wrapped your dev command with `neon-ts env run -- <cmd>`.
 * - Your platform (Vercel, Fly, Railway, …) injected the vars via its own integration.
 *
 * The shape is keyed off the branch policy evaluated for `NEON_BRANCH_NAME` when set,
 * otherwise `NEON_BRANCH_ID` when it is a branch name, otherwise a synthetic `"main"`
 * target. Prefer `fetchEnv` when runtime code needs exact branch-name-aware policy.
 *
 * Throws `PlatformError(EnvNotInjected)` listing every missing/invalid var when the env
 * isn't fully populated, with a fix hint pointing back at `neon-ts env pull/run`.
 *
 * ```ts
 * import config from "../neon";
 * import { parseEnv } from "@neondatabase/platform/v1";
 *
 * const env = parseEnv(config);
 * const db = drizzle(neon(env.postgres.databaseUrl), { schema });
 * // env.auth is statically typed when the config return type has auth: {} or auth.enabled: true.
 * ```
 */
export function parseEnv<const C extends Config>(config: C): NeonEnv<C> {
	const source = process.env;
	const issues: string[] = [];
	const result: Record<string, unknown> = {};
	const desired = resolveConfig(config, {
		name: parseEnvBranchName(source),
		...(source.NEON_BRANCH_ID?.startsWith("br-")
			? { id: source.NEON_BRANCH_ID }
			: {}),
		exists: true,
	});

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

	if (desired.authEnabled) {
		const auth = authEnvSchema.safeParse({
			NEON_AUTH_PROJECT_ID: source.NEON_AUTH_PROJECT_ID,
			NEON_AUTH_PUBLISHABLE_CLIENT_KEY:
				source.NEON_AUTH_PUBLISHABLE_CLIENT_KEY,
			NEON_AUTH_SECRET_SERVER_KEY: source.NEON_AUTH_SECRET_SERVER_KEY,
			NEON_AUTH_JWKS_URL: source.NEON_AUTH_JWKS_URL,
		});
		if (auth.success) {
			result.auth = {
				projectId: auth.data.NEON_AUTH_PROJECT_ID,
				publishableClientKey:
					auth.data.NEON_AUTH_PUBLISHABLE_CLIENT_KEY,
				secretServerKey: auth.data.NEON_AUTH_SECRET_SERVER_KEY,
				jwksUrl: auth.data.NEON_AUTH_JWKS_URL,
			} satisfies NeonAuthEnv;
		} else {
			for (const issue of auth.error.issues) issues.push(issue.message);
		}
	}

	if (desired.dataApiEnabled) {
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

	if (issues.length > 0) {
		throw new PlatformError(
			ErrorCode.EnvNotInjected,
			[
				"parseEnv: the required Neon env variables are not present in process.env.",
				...issues.map((i) => `  - ${i}`),
				"Inject them via one of:",
				"  - `neon-ts env pull` (writes them to .env.local, picked up by Next.js/Vite/etc.)",
				"  - `neon-ts env run -- <your dev command>` (wraps the command with the vars injected)",
				"  - your hosting platform's Neon integration (Vercel, Fly, Railway, …)",
				"Or switch the call to `await fetchEnv(config)` if you're in a context that can do async I/O.",
			].join("\n"),
			{ details: { missing: issues } },
		);
	}

	return result as NeonEnv<C>;
}

function parseEnvBranchName(source: NodeJS.ProcessEnv): string {
	const explicit = source.NEON_BRANCH_NAME;
	if (explicit && explicit.trim() !== "") return explicit.trim();
	const branch = source.NEON_BRANCH_ID;
	if (branch && !branch.startsWith("br-")) return branch;
	return "main";
}

// ───────────────────────── env-var mapping helpers ─────────────────────────

/**
 * Project a fully-resolved {@link NeonEnv} into the OS-level `{ KEY: value }` pairs used
 * for cross-process transport. Shared by `neon-ts env pull` (writes them to a file) and
 * `neon-ts env run` (injects them into a subprocess's `process.env`).
 *
 * Walks the value at runtime so it works for any `NeonEnv<C>` regardless of which
 * conditional namespaces are present.
 */
export function neonEnvToProcessEnv(
	env: NeonEnv<Config>,
): Record<string, string> {
	const out: Record<string, string> = {
		[NEON_ENV_VAR_KEYS.postgres.databaseUrl]: env.postgres.databaseUrl,
		[NEON_ENV_VAR_KEYS.postgres.databaseUrlUnpooled]:
			env.postgres.databaseUrlUnpooled,
	};
	const withAuth = env as { auth?: NeonAuthEnv };
	if (withAuth.auth) {
		out[NEON_ENV_VAR_KEYS.auth.projectId] = withAuth.auth.projectId;
		out[NEON_ENV_VAR_KEYS.auth.publishableClientKey] =
			withAuth.auth.publishableClientKey;
		out[NEON_ENV_VAR_KEYS.auth.secretServerKey] =
			withAuth.auth.secretServerKey;
		out[NEON_ENV_VAR_KEYS.auth.jwksUrl] = withAuth.auth.jwksUrl;
	}
	const withDataApi = env as { dataApi?: NeonDataApiEnv };
	if (withDataApi.dataApi) {
		out[NEON_ENV_VAR_KEYS.dataApi.url] = withDataApi.dataApi.url;
	}
	return out;
}
