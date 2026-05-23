import { z } from "zod";
import { createNeonApiFromOptions } from "./auth.js";
import { ErrorCode, PlatformError } from "./errors.js";
import { type BranchRef, loadContext } from "./load-context.js";
import type {
	NeonApi,
	NeonBranchSnapshot,
	NeonDatabaseSnapshot,
	NeonRoleSnapshot,
} from "./neon-api.js";
import type { Config } from "./types.js";

/**
 * Mapping between the {@link NeonEnv} property paths and the OS-level env-var keys used
 * for cross-process transport (via `.env` files, `env run -- <cmd>`, or anything else
 * that talks to `process.env`).
 *
 * The shape is fixed on purpose so the SDK, CLI, and consumer apps all agree on the wire
 * format. Updating a key here is a breaking change for downstream `.env` files.
 */
export const NEON_ENV_VAR_KEYS = {
	postgres: {
		databaseUrl: "DATABASE_URL",
		databaseUrlUnpooled: "DATABASE_URL_UNPOOLED",
	},
} as const;

/**
 * Static, namespaced shape of `fetchEnv` / `parseEnv`'s return value. Fixed and known —
 * there's no call-site or config-driven configurability — so consumers can destructure
 * with autocomplete and zero `Record<string, string>` widening.
 *
 * Future namespaces (e.g. `vector`, `s3`, …) can be added alongside `postgres` without
 * breaking the existing surface. Keep keys lowercase camelCase.
 */
export interface NeonEnv {
	/** Postgres connection strings for the resolved branch. */
	postgres: {
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
	};
}

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
	/** Explicit org id. Accepted for parity with the rest of the SDK. */
	orgId?: string;
	/**
	 * Explicit branch id (`br-…`) or branch name. Resolution chain:
	 * `options.branch` → `NEON_BRANCH_ID` env → context file → first key in
	 * `config.branches` (typically `"production"`) → project default branch.
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
	/**
	 * Override `process.env` for testing. Read keys: `NEON_PROJECT_ID`, `NEON_BRANCH_ID`,
	 * `NEON_ORG_ID`, `NEON_API_KEY`. Real callers should leave this undefined.
	 */
	env?: Record<string, string | undefined>;
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
 * | `branch`       | `options.branch`      | `NEON_BRANCH_ID`  | `branchId`                 | `branchId`         | first key in `config.branches`|
 * | `roleName`     | `options.roleName`    | —                 | —                          | —                  | auto-pick if branch has one   |
 * | `databaseName` | `options.databaseName`| —                 | —                          | —                  | auto-pick if branch has one   |
 *
 * The package does **not** mutate `process.env` or the filesystem itself.
 */
export async function fetchEnv(
	config: Config,
	options: FetchEnvOptions = {},
): Promise<NeonEnv> {
	const api = options.api ?? createApiFromOptions(options);

	const ctx = loadContext({
		...(options.projectId ? { projectId: options.projectId } : {}),
		...(options.orgId ? { orgId: options.orgId } : {}),
		...(options.branch ? { branch: options.branch } : {}),
		...(options.cwd ? { cwd: options.cwd } : {}),
		...(options.env ? { env: options.env } : {}),
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

	const branch = resolveBranch(ctx.branch, branches, config);

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

	const [pooled, unpooled] = await Promise.all([
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
	]);

	return {
		postgres: {
			databaseUrl: pooled.uri,
			databaseUrlUnpooled: unpooled.uri,
		},
	};
}

function createApiFromOptions(options: FetchEnvOptions): NeonApi {
	return createNeonApiFromOptions("fetchEnv", {
		...(options.apiKey ? { apiKey: options.apiKey } : {}),
		...(options.env ? { env: options.env } : {}),
	});
}

function resolveBranch(
	requested: BranchRef | undefined,
	branches: NeonBranchSnapshot[],
	config: Config,
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

	// Fall back to the first concrete branch key (typically "production"). When no
	// `branches` map is defined we don't peek into `branchBlueprints` — those entries
	// are templates that don't correspond to a single concrete branch by themselves.
	const branchKey = firstBranchKey(config);
	if (branchKey) {
		const named = branches.find((b) => b.name === branchKey);
		if (named) return named;
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

function firstBranchKey(config: Config): string | undefined {
	const branches = config.branches;
	if (!branches) return undefined;
	const keys = Object.keys(branches);
	return keys[0];
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

export interface ParseEnvOptions {
	/**
	 * Override the env source. Defaults to `process.env`. Real callers should leave this
	 * undefined; tests can pass a fixture object.
	 */
	env?: Record<string, string | undefined>;
}

/**
 * Schema for the OS-level env vars `parseEnv` reads. Mirrors {@link NEON_ENV_VAR_KEYS} —
 * if you add a key there, add it here too.
 *
 * `z.string().url()` would be tighter than `min(1)` but Postgres URIs that include
 * URL-illegal characters in the password (rare but legal in Neon's own connection-string
 * format) fail the WHATWG `URL` parse, so we settle for "non-empty string".
 */
const neonEnvSchema = z.object({
	DATABASE_URL: z
		.string({ message: "DATABASE_URL is missing" })
		.min(1, "DATABASE_URL must not be empty"),
	DATABASE_URL_UNPOOLED: z
		.string({ message: "DATABASE_URL_UNPOOLED is missing" })
		.min(1, "DATABASE_URL_UNPOOLED must not be empty"),
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
 * - Your platform (Vercel, Fly, Railway, …) injected `DATABASE_URL` via its own
 *   integration.
 *
 * Throws `PlatformError(EnvNotInjected)` listing every missing/invalid var when the env
 * isn't fully populated, with a fix hint pointing back at `neon-ts env pull/run`.
 *
 * The `config` argument is currently unused at runtime — it exists for symmetry with
 * `fetchEnv(config)` and so future namespaces (`vector`, `s3`, …) can hang off the same
 * call site without breaking the API.
 *
 * ```ts
 * import config from "../neon";
 * import { parseEnv } from "@neondatabase/platform/v1";
 *
 * const env = parseEnv(config);
 * const db = drizzle(neon(env.postgres.databaseUrl), { schema });
 * ```
 */
export function parseEnv(
	_config: Config,
	options: ParseEnvOptions = {},
): NeonEnv {
	const source = options.env ?? process.env;
	const result = neonEnvSchema.safeParse({
		DATABASE_URL: source.DATABASE_URL,
		DATABASE_URL_UNPOOLED: source.DATABASE_URL_UNPOOLED,
	});
	if (!result.success) {
		const issues = result.error.issues.map((i) => `  - ${i.message}`);
		throw new PlatformError(
			ErrorCode.EnvNotInjected,
			[
				"parseEnv: the required Neon env variables are not present in process.env.",
				...issues,
				"Inject them via one of:",
				"  - `neon-ts env pull` (writes them to .env.local, picked up by Next.js/Vite/etc.)",
				"  - `neon-ts env run -- <your dev command>` (wraps the command with the vars injected)",
				"  - your hosting platform's Neon integration (Vercel, Fly, Railway, …)",
				"Or switch the call to `await fetchEnv(config)` if you're in a context that can do async I/O.",
			].join("\n"),
			{
				details: {
					missing: result.error.issues.map((i) => i.path.join(".")),
				},
			},
		);
	}
	return {
		postgres: {
			databaseUrl: result.data.DATABASE_URL,
			databaseUrlUnpooled: result.data.DATABASE_URL_UNPOOLED,
		},
	};
}

// ───────────────────────── env-var mapping helpers ─────────────────────────

/**
 * Project a fully-resolved {@link NeonEnv} into the OS-level `{ KEY: value }` pairs used
 * for cross-process transport. Shared by `neon-ts env pull` (writes them to a file) and
 * `neon-ts env run` (injects them into a subprocess's `process.env`).
 */
export function neonEnvToProcessEnv(env: NeonEnv): Record<string, string> {
	return {
		[NEON_ENV_VAR_KEYS.postgres.databaseUrl]: env.postgres.databaseUrl,
		[NEON_ENV_VAR_KEYS.postgres.databaseUrlUnpooled]:
			env.postgres.databaseUrlUnpooled,
	};
}
