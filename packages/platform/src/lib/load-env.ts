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
 * Static, namespaced shape of `loadEnv`'s return value. Fixed and known — there's no
 * call-site or config-driven configurability — so consumers can destructure with
 * autocomplete and zero `Record<string, string>` widening.
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

export interface LoadEnvOptions {
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
 * Resolve the project + branch this process should target, then fetch the live Neon
 * connection strings for that branch. Returns a fixed-shape, statically-typed
 * {@link NeonEnv} — namespaced (`env.postgres.databaseUrl`, …) so future namespaces
 * (`vector`, `s3`, …) can be added without breaking the existing shape.
 *
 * Typical usage in an application bootstrap (no `.env` entries for connection strings
 * required — `neon-ts` / `neonctl link` writes `.neon/project.json` once and `loadEnv`
 * picks it up from there):
 *
 * ```ts
 * import config from "../neon";
 * import { loadEnv } from "@neondatabase/platform/v1";
 *
 * const env = await loadEnv(config);
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
export async function loadEnv(
	config: Config,
	options: LoadEnvOptions = {},
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
				`loadEnv: project ${ctx.projectId} has no branches.`,
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

function createApiFromOptions(options: LoadEnvOptions): NeonApi {
	return createNeonApiFromOptions("loadEnv", {
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
				`loadEnv: branch ${describeRef(requested)} not found on project.`,
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
			"loadEnv: no branches available on the project.",
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
					`loadEnv: role "${requested}" not found on branch ${branch.name} (${branch.id}).`,
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
				`loadEnv: branch ${branch.name} (${branch.id}) has no roles.`,
				"Create one via the Neon console or pass `roleName` explicitly.",
			].join(" "),
			{ details: { branchId: branch.id } },
		);
	}
	if (roles.length === 1) return roles[0].name;
	throw new PlatformError(
		ErrorCode.AmbiguousBranchAuth,
		[
			`loadEnv: branch ${branch.name} (${branch.id}) has ${roles.length} roles; cannot auto-pick.`,
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
					`loadEnv: database "${requested}" not found on branch ${branch.name} (${branch.id}).`,
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
				`loadEnv: branch ${branch.name} (${branch.id}) has no databases.`,
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
			`loadEnv: branch ${branch.name} (${branch.id}) has ${databases.length} databases; cannot auto-pick.`,
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
