import {
	type Config,
	createNeonApiFromOptions,
	ErrorCode,
	type NeonApi,
	type NeonBranchSnapshot,
	type NeonDatabaseSnapshot,
	type NeonRoleSnapshot,
	PlatformError,
	resolveConfig,
	type ServiceToggleInput,
} from "@neondatabase/config/v1";
import { z } from "zod";

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
/**
 * Neon's default branch owner role, created with every project. This is the role a
 * `DATABASE_URL` should connect as.
 */
const NEON_DEFAULT_OWNER_ROLE = "neondb_owner";

/**
 * Roles Neon provisions for the Auth / Data API (PostgREST) stack. They exist to back
 * RLS-scoped Data API requests authenticated by JWT — never to hold a `DATABASE_URL` —
 * so they're skipped when auto-picking the connection role. Enabling Neon Auth or the
 * Data API (`neon config apply`) adds these next to the owner role, which is why a plain
 * branch routinely reports more than one role.
 */
const NEON_MANAGED_AUTH_ROLES: ReadonlySet<string> = new Set([
	"authenticator",
	"anonymous",
	"authenticated",
]);

export const NEON_ENV_VAR_KEYS = {
	postgres: {
		databaseUrl: "DATABASE_URL",
		databaseUrlUnpooled: "DATABASE_URL_UNPOOLED",
	},
	auth: {
		baseUrl: "NEON_AUTH_BASE_URL",
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
 * Bits of a Neon Auth integration for the resolved branch. Only present on `NeonEnv`
 * when the branch policy enables `auth`.
 *
 * Neon Auth exposes a single `baseUrl` that doubles as the publishable client identifier
 * — the rest of the surface (project id, JWKS URL, …) is derived from it at runtime by
 * the Neon Auth SDK. `fetchEnv` reads it from the live integration; `parseEnv` reads it
 * from `process.env` (`NEON_AUTH_BASE_URL`).
 */
export interface NeonAuthEnv {
	baseUrl: string;
}

/** Bits of a Neon Data API integration. Only present when the branch policy enables it. */
export interface NeonDataApiEnv {
	url: string;
}

/**
 * Empty record alias used as the "false" branch of the conditional namespace adds below.
 * `Record<never, never>` is the no-op for intersection — the cleaner alternative to `{}`,
 * which biome rejects (it means "any non-null", not "empty object").
 */
type NoNamespace = Record<never, never>;

/**
 * Resolve a **static** service toggle (the value of `config.auth` / `config.dataApi`) to a
 * type-level boolean. The whole-thing wrapping (`[T] extends […]`) turns off distribution
 * so a union/`undefined` is checked as one unit:
 *
 * - `false` / `{ enabled: false }` / `undefined` → `false`
 * - `true` / `{ enabled: true }` / any other object (`{}`, `{ enabled?: boolean }`) → `true`
 *   (a present toggle defaults to enabled)
 * - the bare `boolean | ServiceToggle | undefined` (the default `Config` param, no literal
 *   info) → `false`, so an untyped policy yields just `{ postgres }`.
 */
type ServiceOn<T> = [T] extends [false]
	? false
	: [T] extends [{ enabled: false }]
		? false
		: [T] extends [undefined]
			? false
			: [T] extends [true]
				? true
				: [T] extends [{ enabled: true }]
					? true
					: [T] extends [object]
						? true
						: false;

/**
 * Static, namespaced shape of `fetchEnv` / `parseEnv`'s return value. Generic over the
 * {@link Config} so the type system knows which optional namespaces are present.
 *
 * Because the secret-bearing toggles now live in the **static** top-level `config.auth` /
 * `config.dataApi` (not inside a per-branch closure), the namespace presence is a direct
 * read of those fields — no union-across-branches, no default-config escape hatch:
 *
 * - `postgres` is always present.
 * - `auth` is added iff `config.auth` is statically enabled.
 * - `dataApi` is added iff `config.dataApi` is statically enabled.
 */
export type NeonEnv<C extends Config = Config> = {
	postgres: NeonPostgresEnv;
} & (ServiceOn<NonNullable<C["auth"]>> extends true
	? { auth: NeonAuthEnv }
	: NoNamespace) &
	(ServiceOn<NonNullable<C["dataApi"]>> extends true
		? { dataApi: NeonDataApiEnv }
		: NoNamespace);

/** The static `preview.functions` record of a config, or an empty record when absent. */
type PreviewFunctionsOf<C extends Config> = NonNullable<C["preview"]> extends {
	functions: infer F;
}
	? F
	: Record<never, never>;

/** The declared function slugs of a config (record keys), as a string union. */
export type FunctionSlugOf<C extends Config> = Extract<
	keyof PreviewFunctionsOf<C>,
	string
>;

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

export interface FetchEnvOptions {
	/**
	 * Neon project id. **Required** — the management API addresses branches through their
	 * project. Resolve it in your CLI (e.g. neonctl) and pass it in.
	 */
	projectId: string;
	/** Neon branch id (`br-…`). **Required.** Resolve names to ids before calling. */
	branchId: string;
	/**
	 * Neon API key. Resolved via the standard chain (option → `NEON_API_KEY` →
	 * `~/.config/neonctl/credentials.json`) when omitted. Ignored when a custom `api`
	 * is supplied.
	 */
	apiKey?: string;
	/**
	 * Inject a custom NeonApi adapter. Primarily used by tests; production callers can rely
	 * on the default real adapter built from `apiKey`.
	 */
	api?: NeonApi;
	/**
	 * Role name to fetch credentials for. When omitted, the connection role is auto-picked:
	 * the only role on the branch, else Neon's default owner (`neondb_owner`), else the
	 * single role left after dropping the managed Auth/Data API roles
	 * (`authenticator`/`anonymous`/`authenticated`). Throws {@link PlatformError} with
	 * `PLATFORM_AMBIGUOUS_BRANCH_AUTH` only when more than one app role remains.
	 */
	roleName?: string;
	/**
	 * Database name. When omitted, the only database on the branch is auto-picked; throws
	 * {@link PlatformError} with `PLATFORM_AMBIGUOUS_BRANCH_AUTH` if the branch has more
	 * than one database.
	 */
	databaseName?: string;
	/**
	 * Env source used for one-time Auth keys that cannot be refetched after integration
	 * creation. Defaults to `process.env`; callers may layer values from `.env.local`.
	 */
	env?: NodeJS.ProcessEnv;
}

/**
 * Resolve the project + branch this process should target, then fetch live Neon
 * connection strings for that branch over the network. Async — calls the Neon API.
 *
 * Use this from build scripts and the `neon-env run` command, where top-level await is
 * fine. For application code that needs a synchronous bootstrap (most frameworks: Drizzle
 * config, Next.js, Vite, etc.), inject env vars via `neon-env run -- <cmd>` and use
 * {@link parseEnv} instead — same {@link NeonEnv} shape, but a sync call against
 * `process.env`.
 *
 * Filesystem- and env-agnostic: pass `projectId` and the target `branchId` explicitly
 * (resolve them in your CLI, e.g. neonctl).
 *
 * ```ts
 * import config from "../neon";
 * import { fetchEnv } from "@neondatabase/env/v1";
 *
 * const env = await fetchEnv(config, { projectId: "patient-art-12345", branchId: "br-…" });
 * const db = drizzle(neon(env.postgres.databaseUrl), { schema });
 * ```
 *
 * The package does **not** mutate `process.env` or the filesystem itself.
 */
export async function fetchEnv<const C extends Config>(
	config: C,
	options: FetchEnvOptions,
): Promise<NeonEnv<C>> {
	const api = options.api ?? createApiFromOptions(options);
	const projectId = options.projectId;

	const branches = await api.listBranches(projectId);
	if (branches.length === 0) {
		throw new PlatformError(
			ErrorCode.BranchNotFound,
			[
				`fetchEnv: project ${projectId} has no branches.`,
				"Deploy your neon.ts policy (or create a branch) first, or pick a different project id.",
			].join(" "),
			{ details: { projectId } },
		);
	}

	const branch = resolveBranch(options.branchId, branches);
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
		api.listBranchRoles(projectId, branch.id),
		api.listBranchDatabases(projectId, branch.id),
	]);

	const roleName = pickRoleName(roles, branch, options.roleName);
	const databaseName = pickDatabaseName(
		databases,
		branch,
		roleName,
		options.databaseName,
	);

	// Fan out: always fetch both Postgres URIs. Conditionally fetch auth + dataApi based
	// on the branch policy. Auth key fields are only returned at integration creation time;
	// for Better Auth they may legitimately be empty, so absence in the local env becomes
	// empty string values while still emitting the required variable names.
	const wantsAuth = desired.authEnabled;
	const wantsDataApi = desired.dataApiEnabled;

	const [pooled, unpooled, authSnapshot, dataApiSnapshot] = await Promise.all(
		[
			api.getConnectionUri(projectId, {
				branchId: branch.id,
				databaseName,
				roleName,
				pooled: true,
			}),
			api.getConnectionUri(projectId, {
				branchId: branch.id,
				databaseName,
				roleName,
				pooled: false,
			}),
			wantsAuth
				? api.getNeonAuth(projectId, branch.id)
				: Promise.resolve(null),
			wantsDataApi
				? api.getNeonDataApi(projectId, branch.id, databaseName)
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
					"Enable it via `apply(config, { projectId, branchId })` (or `npx neonctl …`), in the Neon Console — then re-run fetchEnv. Or return auth.enabled=false.",
				].join(" "),
				{
					details: { projectId, branchId: branch.id },
				},
			);
		}
		const baseUrl = resolveAuthBaseUrl(
			authSnapshot.baseUrl,
			options.env ?? process.env,
		);
		result.auth = { baseUrl } satisfies NeonAuthEnv;
	}

	if (wantsDataApi) {
		if (!dataApiSnapshot) {
			throw new PlatformError(
				ErrorCode.NotFound,
				[
					`fetchEnv: branch policy enables dataApi but no Data API integration is enabled on branch ${branch.name} (${branch.id}) database ${databaseName}.`,
					"Enable it via `apply(config, { projectId, branchId })` or in the Neon Console — then re-run fetchEnv. Or return dataApi.enabled=false.",
				].join(" "),
				{
					details: {
						projectId,
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
 * Resolve the Neon Auth base URL to surface in `env.auth`. Prefer the value returned by
 * the integration (`getNeonAuth` includes it); fall back to whatever is already in the
 * caller's env source so older integrations created before `base_url` was returned still
 * round-trip through `env run`.
 */
function resolveAuthBaseUrl(
	snapshotBaseUrl: string | undefined,
	source: NodeJS.ProcessEnv,
): string {
	if (snapshotBaseUrl && snapshotBaseUrl !== "") return snapshotBaseUrl;
	return source[NEON_ENV_VAR_KEYS.auth.baseUrl] ?? "";
}

function createApiFromOptions(options: FetchEnvOptions): NeonApi {
	return createNeonApiFromOptions(
		"fetchEnv",
		options.apiKey ? { apiKey: options.apiKey } : {},
	);
}

function resolveBranch(
	branchId: string,
	branches: NeonBranchSnapshot[],
): NeonBranchSnapshot {
	const match = branches.find((b) => b.id === branchId);
	if (match) return match;
	throw new PlatformError(
		ErrorCode.BranchNotFound,
		[
			`fetchEnv: branch id ${JSON.stringify(branchId)} not found on project.`,
			`Existing branches: ${branches.map((b) => `${b.name} (${b.id})`).join(", ")}.`,
		].join(" "),
		{
			details: {
				branchId,
				available: branches.map((b) => b.id),
			},
		},
	);
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

	// Multiple roles. Enabling Neon Auth / the Data API provisions the PostgREST roles
	// (authenticator/anonymous/authenticated) alongside the project owner, so a normal
	// branch ends up with >1 role even though only the owner backs a `DATABASE_URL`.
	// Default to Neon's owner role; if the project was created with a custom owner name,
	// fall back to the single role left after dropping the managed auth roles. Only a
	// genuinely ambiguous set (more than one app role) still asks the caller to choose.
	const owner = roles.find((r) => r.name === NEON_DEFAULT_OWNER_ROLE);
	if (owner) return owner.name;

	const appRoles = roles.filter((r) => !NEON_MANAGED_AUTH_ROLES.has(r.name));
	if (appRoles.length === 1) return appRoles[0].name;

	throw new PlatformError(
		ErrorCode.AmbiguousBranchAuth,
		[
			`fetchEnv: branch ${branch.name} (${branch.id}) has ${roles.length} roles and none is "${NEON_DEFAULT_OWNER_ROLE}"; cannot auto-pick.`,
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
	NEON_AUTH_BASE_URL: z
		.string({ message: "NEON_AUTH_BASE_URL is missing" })
		.min(1, "NEON_AUTH_BASE_URL must not be empty"),
});

const dataApiEnvSchema = z.object({
	NEON_DATA_API_URL: z
		.string({ message: "NEON_DATA_API_URL is missing" })
		.min(1, "NEON_DATA_API_URL must not be empty"),
});

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
 * The second argument is a **scope**:
 * - omitted — *external* scope (app bootstrap, build scripts, your dev machine). Returns
 *   `{ postgres, auth?, dataApi? }`.
 * - a **function slug** (a key of `config.preview.functions`) — *function* scope: you are
 *   running inside that function. Returns the same branch secrets **plus** a typed
 *   `function` namespace with the function's declared env-var keys.
 *
 * Throws `PlatformError(EnvNotInjected)` listing every missing/invalid var when the env
 * isn't fully populated, with a fix hint pointing back at `neon dev` / `neon-env run`.
 *
 * ```ts
 * import config from "../neon";
 * import { parseEnv } from "@neondatabase/env/v1";
 *
 * // External (app / build):
 * const env = parseEnv(config);
 * const db = drizzle(neon(env.postgres.databaseUrl), { schema });
 *
 * // Inside the "hello" function:
 * const env = parseEnv(config, "hello");
 * env.function.resendApiKey; // typed from hello's declared env keys
 * ```
 */
export function parseEnv<const C extends Config>(config: C): NeonEnv<C>;
export function parseEnv<
	const C extends Config,
	const S extends FunctionSlugOf<C>,
>(config: C, scope: S): NeonEnv<C> & NeonFunctionEnv<C, S>;
export function parseEnv(config: Config, scope?: string): unknown {
	const source = process.env;
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

	if (isServiceEnabledInput(config.auth)) {
		const auth = authEnvSchema.safeParse({
			NEON_AUTH_BASE_URL: source.NEON_AUTH_BASE_URL,
		});
		if (auth.success) {
			result.auth = {
				baseUrl: auth.data.NEON_AUTH_BASE_URL,
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

// ───────────────────────── env-var mapping helpers ─────────────────────────

/**
 * Project a fully-resolved {@link NeonEnv} into the OS-level `{ KEY: value }` pairs used
 * for cross-process transport. Named after the web-platform `.entries()` convention
 * (`URLSearchParams` / `Headers` / `FormData`); returns a `Record` rather than an
 * iterator of tuples since that's the shape env injection needs (wrap with
 * `Object.entries(...)` if you want literal `[key, value]` pairs). Used by `neon-env run`
 * to inject the vars into a subprocess's `process.env`.
 *
 * Walks the value at runtime so it works for any `NeonEnv<C>` regardless of which
 * conditional namespaces are present.
 */
export function toEntries(env: NeonEnv<Config>): Record<string, string> {
	const out: Record<string, string> = {
		[NEON_ENV_VAR_KEYS.postgres.databaseUrl]: env.postgres.databaseUrl,
		[NEON_ENV_VAR_KEYS.postgres.databaseUrlUnpooled]:
			env.postgres.databaseUrlUnpooled,
	};
	const withAuth = env as { auth?: NeonAuthEnv };
	if (withAuth.auth) {
		out[NEON_ENV_VAR_KEYS.auth.baseUrl] = withAuth.auth.baseUrl;
	}
	const withDataApi = env as { dataApi?: NeonDataApiEnv };
	if (withDataApi.dataApi) {
		out[NEON_ENV_VAR_KEYS.dataApi.url] = withDataApi.dataApi.url;
	}
	return out;
}
