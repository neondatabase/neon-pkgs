import {
	type Config,
	type CredentialScope,
	createNeonApiFromOptions,
	deriveCredentialScopes,
	ErrorCode,
	type NeonApi,
	type NeonBranchSnapshot,
	type NeonDatabaseSnapshot,
	type NeonRoleSnapshot,
	PlatformError,
	type ResolvedPreviewConfig,
	resolveConfig,
	type ServiceToggleInput,
} from "@neon/config/v1";
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
	/**
	 * Branch identity. `NEON_BRANCH` carries the branch **name** and is injected into the
	 * Neon Functions runtime on every branch (including the default) by default. `env pull` /
	 * `neon dev` / `neon-env run` emit it too so local dev mirrors the deployed runtime.
	 */
	branch: {
		name: "NEON_BRANCH",
	},
	postgres: {
		databaseUrl: "DATABASE_URL",
		databaseUrlUnpooled: "DATABASE_URL_UNPOOLED",
	},
	auth: {
		baseUrl: "NEON_AUTH_BASE_URL",
		jwksUrl: "NEON_AUTH_JWKS_URL",
	},
	dataApi: {
		url: "NEON_DATA_API_URL",
	},
	/**
	 * Object storage (Preview). The S3 SDKs read `AWS_*` from their standard config chain, so
	 * a branch credential + `neon dev` / `env pull` makes object storage work from env alone.
	 * `region` is injected under the SDK-standard `AWS_REGION`.
	 */
	storage: {
		accessKeyId: "AWS_ACCESS_KEY_ID",
		secretAccessKey: "AWS_SECRET_ACCESS_KEY",
		endpoint: "AWS_ENDPOINT_URL_S3",
		region: "AWS_REGION",
	},
	/**
	 * AI Gateway (Preview). Exposed under the Neon-branded env vars the deployed Functions
	 * runtime injects: `apiKey` is the minted credential's bearer (`NEON_AI_GATEWAY_TOKEN`)
	 * and `baseUrl` is the bare branch gateway host (`NEON_AI_GATEWAY_BASE_URL`,
	 * `scheme://host`, no path). Clients like `@neon/ai-sdk-provider` read these and append the
	 * dialect route (`/v1`, `/openai/v1`, `/anthropic/v1`) themselves (https://github.com/vercel/ai/pull/15997).
	 */
	aiGateway: {
		apiKey: "NEON_AI_GATEWAY_TOKEN",
		baseUrl: "NEON_AI_GATEWAY_BASE_URL",
	},
} as const;

/**
 * Branch identity for the resolved branch. Always present on a `fetchEnv` result (the branch
 * name is always known); on a `parseEnv` result it's present only when `NEON_BRANCH` was
 * injected into `process.env` (the Functions runtime injects it by default, as do `neon dev` /
 * `neon-env run` / `env pull`). `name` is the branch **name** (e.g. `main`, `preview/foo`).
 */
export interface NeonBranchEnv {
	name: string;
}

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
 * Neon Auth exposes the `baseUrl` (which doubles as the publishable client identifier) and
 * the `jwksUrl` used to verify tokens it issues. `fetchEnv` reads both from the live
 * integration; `parseEnv` reads them from `process.env` (`NEON_AUTH_BASE_URL` /
 * `NEON_AUTH_JWKS_URL`).
 */
export interface NeonAuthEnv {
	baseUrl: string;
	/** JWKS URL for verifying tokens issued by Neon Auth (`NEON_AUTH_JWKS_URL`). */
	jwksUrl: string;
}

/** Bits of a Neon Data API integration. Only present when the branch policy enables it. */
export interface NeonDataApiEnv {
	url: string;
}

/**
 * S3-compatible object-storage access for the branch (Preview). Present on `NeonEnv` only
 * when the policy declares `preview.buckets`. Combines a minted branch credential's access
 * keys (`accessKeyId` = the credential's full token id, e.g. `nak_live_…`, which is what the
 * storage gateway authenticates against; `secretAccessKey` = its
 * `s3_secret_access_key`) with the branch's non-secret connection details
 * (`endpoint`/`region`, from `GET .../storage`). Projects to the AWS SDK's
 * standard config env (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_ENDPOINT_URL_S3`,
 * `AWS_REGION`) so the S3 client works from env alone. Neon's storage gateway always
 * requires path-style addressing, so set `forcePathStyle: true` on your S3 client.
 */
export interface NeonStorageEnv {
	accessKeyId: string;
	secretAccessKey: string;
	/** S3-compatible endpoint URL for the branch. */
	endpoint: string;
	/** AWS region string (e.g. `us-east-2`). Injected as `AWS_REGION`. */
	region: string;
}

/**
 * AI Gateway access for the branch (Preview). Present on `NeonEnv` only when the policy
 * enables `preview.aiGateway`. `apiKey` is the minted credential's bearer (`api_token`);
 * `baseUrl` is the bare branch-scoped gateway host
 * (`https://<branchId>-api.ai.<region>.…`, no path). Projects to the Neon-branded env
 * (`NEON_AI_GATEWAY_TOKEN`, `NEON_AI_GATEWAY_BASE_URL`); clients like `@neon/ai-sdk-provider`
 * append the dialect route (`/v1`, `/openai/v1`, `/anthropic/v1`) themselves.
 */
export interface NeonAiGatewayEnv {
	apiKey: string;
	baseUrl: string;
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

/** True when `T` has at least one known key; `false` for `{}` / `never`. */
type HasKeys<T> = [keyof T] extends [never] ? false : true;

/**
 * Whether the policy's **static** `preview` block declares at least one object-storage bucket
 * (`preview.buckets`). Drives whether {@link NeonEnv} carries the `storage` namespace.
 *
 * The leading `[never]` guard is load-bearing: when a policy has no `preview` at all,
 * `NonNullable<C["preview"]>` is `never`, and without the guard the `extends { … }` probe
 * below would vacuously match (everything extends `never`-derived shapes) and `HasKeys<never>`
 * would resolve `true`, wrongly adding the namespace. The guard short-circuits to `false`.
 */
type HasBuckets<C extends Config> = [NonNullable<C["preview"]>] extends [never]
	? false
	: NonNullable<C["preview"]> extends { buckets: infer B }
		? HasKeys<NonNullable<B>>
		: false;

/**
 * Whether the policy's **static** `preview` block enables the AI Gateway
 * (`preview.aiGateway`). Drives whether {@link NeonEnv} carries the `aiGateway` namespace.
 *
 * The leading `[never]` guard is load-bearing for the same reason as {@link HasBuckets}: when
 * a policy has no `preview`, `NonNullable<C["preview"]>` is `never`, and a naked `never` in the
 * `extends` below would *distribute* (collapsing the result — and the whole `NeonEnv`
 * intersection — to `never`). The tuple-wrapped guard short-circuits that to `false`.
 */
type AiGatewayOn<C extends Config> = [NonNullable<C["preview"]>] extends [never]
	? false
	: NonNullable<C["preview"]> extends { aiGateway: infer A }
		? ServiceOn<NonNullable<A>>
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
 * - `storage` is added iff `config.preview.buckets` declares at least one bucket.
 * - `aiGateway` is added iff `config.preview.aiGateway` is statically enabled.
 */
export type NeonEnv<C extends Config = Config> = {
	postgres: NeonPostgresEnv;
	/**
	 * Branch identity (`NEON_BRANCH`). Optional because `parseEnv` only surfaces it when the
	 * var was injected; `fetchEnv` always populates it.
	 */
	branch?: NeonBranchEnv;
} & (ServiceOn<NonNullable<C["auth"]>> extends true
	? { auth: NeonAuthEnv }
	: NoNamespace) &
	(ServiceOn<NonNullable<C["dataApi"]>> extends true
		? { dataApi: NeonDataApiEnv }
		: NoNamespace) &
	(HasBuckets<C> extends true ? { storage: NeonStorageEnv } : NoNamespace) &
	(AiGatewayOn<C> extends true
		? { aiGateway: NeonAiGatewayEnv }
		: NoNamespace);

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

// ───────────────────────── parseEnv key filtering ─────────────────────────

/**
 * OS-level env-var keys grouped by the {@link NeonEnv} namespace they populate. Only the
 * **input** vars `parseEnv` validates are listed — the output-only aliases in
 * {@link NEON_ENV_VAR_KEYS} (`NEON_AI_GATEWAY_TOKEN`, …) are intentionally absent, so they
 * are not selectable in a `parseEnv(config, keys)` filter. Keep in sync with
 * {@link EnvKeyToProp}.
 */
interface EnvKeysByNamespace {
	postgres: "DATABASE_URL" | "DATABASE_URL_UNPOOLED";
	auth: "NEON_AUTH_BASE_URL" | "NEON_AUTH_JWKS_URL";
	dataApi: "NEON_DATA_API_URL";
	storage:
		| "AWS_ACCESS_KEY_ID"
		| "AWS_SECRET_ACCESS_KEY"
		| "AWS_ENDPOINT_URL_S3"
		| "AWS_REGION";
	aiGateway: "NEON_AI_GATEWAY_TOKEN" | "NEON_AI_GATEWAY_BASE_URL";
}

/** The {@link NeonEnv} namespace interface backing each namespace key. */
interface NamespaceEnv {
	postgres: NeonPostgresEnv;
	auth: NeonAuthEnv;
	dataApi: NeonDataApiEnv;
	storage: NeonStorageEnv;
	aiGateway: NeonAiGatewayEnv;
}

/** OS-level env-var key → the camelCase property it sets on its namespace object. */
interface EnvKeyToProp {
	DATABASE_URL: "databaseUrl";
	DATABASE_URL_UNPOOLED: "databaseUrlUnpooled";
	NEON_AUTH_BASE_URL: "baseUrl";
	NEON_AUTH_JWKS_URL: "jwksUrl";
	NEON_DATA_API_URL: "url";
	AWS_ACCESS_KEY_ID: "accessKeyId";
	AWS_SECRET_ACCESS_KEY: "secretAccessKey";
	AWS_ENDPOINT_URL_S3: "endpoint";
	AWS_REGION: "region";
	NEON_AI_GATEWAY_TOKEN: "apiKey";
	NEON_AI_GATEWAY_BASE_URL: "baseUrl";
}

/**
 * The OS-level env-var keys selectable for a given policy: the union of input vars across
 * exactly the namespaces {@link NeonEnv}<C> carries. Drives the typesafe autocomplete of the
 * `keys` filter — selecting a var from a namespace the policy does not enable is a type error
 * (e.g. `NEON_AUTH_BASE_URL` is only offered once the policy turns on `auth`).
 */
export type SelectableEnvKey<C extends Config> =
	EnvKeysByNamespace[keyof NeonEnv<C> & keyof EnvKeysByNamespace];

/**
 * The result shape of a **filtered** `parseEnv(config, keys)` call: the namespaced
 * {@link NeonEnv} restricted to exactly the selected OS-level keys `K`. Namespaces with no
 * selected key are dropped, and within a kept namespace only the selected properties survive
 * — selecting just `["DATABASE_URL"]` yields `{ postgres: { databaseUrl: string } }`, with no
 * `databaseUrlUnpooled`.
 *
 * The policy gating lives on the `parseEnv` overload (which binds `K` to
 * {@link SelectableEnvKey}); this type only needs the selection, so it takes a bare
 * `K extends string` and filters with `Extract`. The outer mapped type's `as` clause drops
 * any namespace whose intersection with the selection is empty (`[…] extends [never]`,
 * tuple-wrapped to switch off distribution); the inner one re-keys each selected OS var to its
 * camelCase property and looks the value type up on the canonical namespace interface, so it
 * stays correct if a field ever stops being a plain `string`.
 */
export type FilteredNeonEnv<K extends string> = {
	[N in keyof EnvKeysByNamespace as [
		Extract<K, EnvKeysByNamespace[N]>,
	] extends [never]
		? never
		: N]: {
		[P in Extract<K, EnvKeysByNamespace[N]> as EnvKeyToProp[P &
			keyof EnvKeyToProp]]: NamespaceEnv[N][EnvKeyToProp[P &
			keyof EnvKeyToProp] &
			keyof NamespaceEnv[N]];
	};
};

export interface FetchEnvOptions {
	/**
	 * Neon project id. **Required** — the management API addresses branches through their
	 * project. Resolve it in your CLI (e.g. neonctl) and pass it in.
	 */
	projectId: string;
	/**
	 * Neon branch — its **name** (e.g. `main`) or its id (`br-…`). **Required** (or pass the
	 * legacy {@link FetchEnvOptions.branchId}). Resolved against the project's branches by
	 * id first, then by name, so either form works.
	 */
	branch?: string;
	/**
	 * @deprecated Legacy id-only field. Prefer {@link FetchEnvOptions.branch}, which accepts
	 * a branch name or id. Still honored for backward compatibility; ignored when `branch`
	 * is set.
	 */
	branchId?: string;
	/**
	 * Neon API key. Resolved via the standard chain (option → `NEON_API_KEY` →
	 * `~/.config/neonctl/credentials.json`) when omitted. Ignored when a custom `api`
	 * is supplied.
	 */
	apiKey?: string;
	/**
	 * Neon **management** API base URL (not the Auth base URL). Falls back to
	 * `NEON_API_HOST`, then production. Ignored when a custom `api` is supplied.
	 */
	apiHost?: string;
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
 * Filesystem- and env-agnostic: pass `projectId` and the target `branch` (name or id)
 * explicitly (resolve them in your CLI, e.g. neonctl).
 *
 * ```ts
 * import config from "../neon";
 * import { fetchEnv } from "@neon/env";
 *
 * const env = await fetchEnv(config, { projectId: "patient-art-12345", branch: "main" });
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

	const branchRef = options.branch ?? options.branchId;
	if (!branchRef) {
		throw new PlatformError(
			ErrorCode.BranchNotFound,
			[
				"fetchEnv: no branch provided.",
				"Pass `branch` with a branch name (e.g. `main`) or id (`br-…`).",
			].join(" "),
			{ details: { projectId } },
		);
	}
	const branch = resolveBranch(branchRef, branches);
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
		// Branch identity, mirroring what the Functions runtime injects on every branch.
		// Surfaced as `NEON_BRANCH` so local dev (`neon dev` / `neon-env run` / `env pull`)
		// matches the deployed runtime. Uses the branch name.
		branch: { name: branch.name } satisfies NeonBranchEnv,
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
		const envSource = options.env ?? process.env;
		const baseUrl = resolveAuthBaseUrl(authSnapshot.baseUrl, envSource);
		const jwksUrl = resolveAuthJwksUrl(authSnapshot.jwksUrl, envSource);
		result.auth = { baseUrl, jwksUrl } satisfies NeonAuthEnv;
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

	// Object storage + AI Gateway (Preview). A single branch credential is minted (once) to
	// back whichever of these the policy enables; functions never force a credential but ride
	// along on its scopes. None of this runs when the policy enables neither, so the
	// Postgres / Auth / Data API path never touches the credentials/storage endpoints (and
	// keeps working on production, where they may not exist yet).
	const wantsStorage = (desired.preview?.buckets.length ?? 0) > 0;
	const wantsAiGateway = desired.preview?.aiGatewayEnabled ?? false;
	if (wantsStorage || wantsAiGateway) {
		const secrets = await resolveCredentialSecrets({
			api,
			projectId,
			branchId: branch.id,
			branchName: branch.name,
			scopes: previewCredentialScopes(desired.preview),
			env: options.env ?? process.env,
			needStorage: wantsStorage,
			needApiToken: wantsAiGateway,
		});
		if (wantsStorage) {
			const storage = await api.getProjectBranchStorage(
				projectId,
				branch.id,
			);
			if (!storage) {
				throw new PlatformError(
					ErrorCode.NotFound,
					[
						`fetchEnv: branch policy declares object storage (preview.buckets) but storage is not enabled on branch ${branch.name} (${branch.id}).`,
						"Enable it via `apply(config, { projectId, branchId })` (or in the Neon Console) — then re-run fetchEnv. Or remove preview.buckets.",
					].join(" "),
					{ details: { projectId, branchId: branch.id } },
				);
			}
			result.storage = {
				accessKeyId: secrets.accessKeyId,
				secretAccessKey: secrets.secretAccessKey,
				endpoint: storage.s3Endpoint,
				region: storage.region,
			} satisfies NeonStorageEnv;
		}
		if (wantsAiGateway) {
			result.aiGateway = {
				apiKey: secrets.apiToken,
				// Bare branch-scoped gateway host derived from the branch's connection URI —
				// not the control-plane API origin (which doesn't serve the gateway). Clients
				// append the dialect route (/v1, /openai/v1, /anthropic/v1) themselves.
				baseUrl: aiGatewayBaseUrl(branch.id, unpooled.uri),
			} satisfies NeonAiGatewayEnv;
		}
	}

	return result as NeonEnv<C>;
}

/**
 * Scopes the branch credential should carry for a resolved branch policy. Only object storage
 * and the AI Gateway *require* a credential; functions never force one (they have no credential
 * of their own), but `functions:invoke` is added to the scope set when a credential is already
 * being minted for storage / the AI Gateway, so the one credential can invoke the branch's
 * functions too. Returns `[]` only when nothing credential-bearing is enabled.
 */
function previewCredentialScopes(
	preview: ResolvedPreviewConfig | undefined,
): CredentialScope[] {
	if (!preview) return [];
	const storage = preview.buckets.length > 0;
	const aiGateway = preview.aiGatewayEnabled;
	if (!storage && !aiGateway) return [];
	return deriveCredentialScopes({
		storage,
		aiGateway,
		functions: preview.functions.length > 0,
	});
}

/**
 * Resolve the branch credential's secrets, reusing the ones already in the env source when
 * present and minting a fresh `user` credential otherwise. The Neon API returns `api_token` /
 * `s3_secret_access_key` exactly once at mint time, so the persisted copies (e.g. in
 * `.env.local`, surfaced as `NEON_AI_GATEWAY_TOKEN` / `AWS_SECRET_ACCESS_KEY`) are the only way to
 * recover them — exactly how one-time Auth keys are round-tripped. Reuse is presence-based
 * (no extra bookkeeping vars): if every secret the enabled features need is already present,
 * reuse it; otherwise mint one credential covering all currently-needed scopes.
 */
async function resolveCredentialSecrets(args: {
	api: NeonApi;
	projectId: string;
	branchId: string;
	branchName: string;
	scopes: CredentialScope[];
	env: NodeJS.ProcessEnv;
	needStorage: boolean;
	needApiToken: boolean;
}): Promise<{
	accessKeyId: string;
	secretAccessKey: string;
	apiToken: string;
}> {
	const sKeys = NEON_ENV_VAR_KEYS.storage;
	const aKeys = NEON_ENV_VAR_KEYS.aiGateway;
	const haveStorage =
		!args.needStorage ||
		Boolean(args.env[sKeys.accessKeyId] && args.env[sKeys.secretAccessKey]);
	const haveApiToken = !args.needApiToken || Boolean(args.env[aKeys.apiKey]);
	if (haveStorage && haveApiToken) {
		return {
			accessKeyId: args.env[sKeys.accessKeyId] ?? "",
			secretAccessKey: args.env[sKeys.secretAccessKey] ?? "",
			apiToken: args.env[aKeys.apiKey] ?? "",
		};
	}
	const minted = await args.api.createCredential(
		args.projectId,
		args.branchId,
		{
			scopes: args.scopes,
			principalType: "user",
			name: `neon-env ${args.branchName}`,
		},
	);
	return {
		// The storage gateway authenticates against the full token id (e.g.
		// `nak_live_…`), not the short token id — using the short id yields
		// `InvalidAccessKeyId` on every S3 request.
		accessKeyId: minted.tokenId,
		secretAccessKey: minted.s3SecretAccessKey,
		apiToken: minted.apiToken,
	};
}

/**
 * The AI Gateway is a **branch-scoped host** — `<branchId>-api.ai.<host-suffix>` — NOT the
 * control-plane API origin. Derive the suffix from the branch's own Postgres connection host
 * by dropping only the endpoint label (the first segment) and keeping everything after it,
 * including any infra cell prefix (`c-N.`): a connection host of
 * `ep-x.c-3.us-east-2.aws.neon.tech` yields the gateway host
 * `<branchId>-api.ai.c-3.us-east-2.aws.neon.tech`. The cell prefix is **load-bearing** —
 * the gateway is cell-routed, so dropping `c-N.` resolves to the wrong (or no) host.
 */
function aiGatewayHost(branchId: string, connectionUri: string): string {
	let connectionHost = "";
	try {
		connectionHost = new URL(connectionUri).hostname;
	} catch {
		connectionHost = "";
	}
	// Drop the endpoint label (first segment, e.g. `ep-x` / `ep-x-pooler`), keeping the rest
	// of the host verbatim — including any infra cell prefix (`c-N.`) the gateway routes on:
	// `[c-N.]<region>.<cloud>.neon.<tld>`.
	const suffix = connectionHost.split(".").slice(1).join(".");
	return `${branchId}-api.ai.${suffix}`;
}

/** The AI Gateway's bare base URL (`NEON_AI_GATEWAY_BASE_URL`) on the branch gateway host. */
function aiGatewayBaseUrl(branchId: string, connectionUri: string): string {
	return `https://${aiGatewayHost(branchId, connectionUri)}`;
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

/**
 * Resolve the Neon Auth JWKS URL to surface in `env.auth`. Prefer the value returned by the
 * integration (`getNeonAuth` always includes `jwks_url`); fall back to the caller's env
 * source so the value still round-trips through `env run` if a snapshot ever omits it.
 */
function resolveAuthJwksUrl(
	snapshotJwksUrl: string | undefined,
	source: NodeJS.ProcessEnv,
): string {
	if (snapshotJwksUrl && snapshotJwksUrl !== "") return snapshotJwksUrl;
	return source[NEON_ENV_VAR_KEYS.auth.jwksUrl] ?? "";
}

function createApiFromOptions(options: FetchEnvOptions): NeonApi {
	return createNeonApiFromOptions("fetchEnv", {
		...(options.apiKey ? { apiKey: options.apiKey } : {}),
		...(options.apiHost ? { apiHost: options.apiHost } : {}),
	});
}

/**
 * Resolve a branch ref — a name or an id — to a concrete branch. Matches by id first
 * (exact `br-…`), then by name; both are unique within a project, so the lookup is
 * unambiguous. This lets `.neon` files written by `neonctl` (which pin the branch *name*)
 * and explicit `br-…` ids both work.
 */
function resolveBranch(
	branch: string,
	branches: NeonBranchSnapshot[],
): NeonBranchSnapshot {
	const match =
		branches.find((b) => b.id === branch) ??
		branches.find((b) => b.name === branch);
	if (match) return match;
	throw new PlatformError(
		ErrorCode.BranchNotFound,
		[
			`fetchEnv: branch ${JSON.stringify(branch)} not found on project (matched by id or name).`,
			`Existing branches: ${branches.map((b) => `${b.name} (${b.id})`).join(", ")}.`,
		].join(" "),
		{
			details: {
				branch,
				available: branches.map((b) => `${b.name} (${b.id})`),
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
 *   `function` namespace with the function's declared env-var keys.
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
export function parseEnv<
	const C extends Config,
	const K extends SelectableEnvKey<C>,
>(config: C, keys: readonly K[]): FilteredNeonEnv<K>;
export function parseEnv<
	const C extends Config,
	const S extends FunctionSlugOf<C>,
>(config: C, scope: S): NeonEnv<C> & NeonFunctionEnv<C, S>;
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
): Record<string, Record<string, string>> {
	const issues: string[] = [];
	const result: Record<string, Record<string, string>> = {};
	for (const key of keys) {
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
	if (env.branch) {
		out[NEON_ENV_VAR_KEYS.branch.name] = env.branch.name;
	}
	const withAuth = env as { auth?: NeonAuthEnv };
	if (withAuth.auth) {
		out[NEON_ENV_VAR_KEYS.auth.baseUrl] = withAuth.auth.baseUrl;
		out[NEON_ENV_VAR_KEYS.auth.jwksUrl] = withAuth.auth.jwksUrl;
	}
	const withDataApi = env as { dataApi?: NeonDataApiEnv };
	if (withDataApi.dataApi) {
		out[NEON_ENV_VAR_KEYS.dataApi.url] = withDataApi.dataApi.url;
	}
	const withStorage = env as { storage?: NeonStorageEnv };
	if (withStorage.storage) {
		const s = withStorage.storage;
		const keys = NEON_ENV_VAR_KEYS.storage;
		out[keys.accessKeyId] = s.accessKeyId;
		out[keys.secretAccessKey] = s.secretAccessKey;
		out[keys.endpoint] = s.endpoint;
		out[keys.region] = s.region;
	}
	const withAiGateway = env as { aiGateway?: NeonAiGatewayEnv };
	if (withAiGateway.aiGateway) {
		const keys = NEON_ENV_VAR_KEYS.aiGateway;
		const ai = withAiGateway.aiGateway;
		// Neon-branded vars only: the bearer and the bare branch gateway host
		// (scheme://host, no path) — the @neon/ai-sdk-provider appends the
		// dialect route (/v1, /openai/v1, /anthropic/v1) itself (https://github.com/vercel/ai/pull/15997).
		out[keys.apiKey] = ai.apiKey;
		out[keys.baseUrl] = ai.baseUrl;
	}
	return out;
}
