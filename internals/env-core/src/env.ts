/**
 * The Neon env core — resolving a branch's env from the Neon API, and projecting it into
 * OS-level `{ KEY: value }` pairs.
 *
 * Private, and bundled into both consumers: `@neon/env` publishes it as `fetchEnv` /
 * `toEntries`, and the `neon` CLI needs the credential-reuse half in `reuse-secrets.ts`.
 * See `README.md` for why it is not published.
 *
 * The counterpart that reads `process.env` — `parseEnv` and its zod schemas — is not here. It
 * has no consumer outside `@neon/env`, so it stays in that package and imports this.
 */

import {
	type Config,
	type CredentialScope,
	createNeonApiFromOptions,
	deriveCredentialScopes,
	ErrorCode,
	isPlatformError,
	type NeonApi,
	type NeonBranchSnapshot,
	type NeonBranchStorageSnapshot,
	type NeonDatabaseSnapshot,
	type NeonRoleSnapshot,
	PlatformError,
	type ResolvedPreviewConfig,
	resolveConfig,
} from "@neon/config/v1";

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
 * Neon's default database, created with every project. When a branch has several databases
 * and none was requested, this is preferred for the `DATABASE_URL` so the common case (a
 * user added a second database next to `neondb`) auto-picks without asking.
 */
const NEON_DEFAULT_DATABASE = "neondb";

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

export type FunctionBaseUrlKey<Slug extends string = string> =
	`NEON_FUNCTION_${Uppercase<Slug>}_BASE_URL`;

const FUNCTION_SLUG = /^[a-z0-9]{1,20}$/;
const FUNCTION_BASE_URL_KEY = /^NEON_FUNCTION_([A-Z0-9]{1,20})_BASE_URL$/;

export function functionBaseUrlKey<S extends string>(
	slug: S,
): FunctionBaseUrlKey<S> {
	if (!FUNCTION_SLUG.test(slug)) {
		throw new Error(
			`functionBaseUrlKey: ${JSON.stringify(slug)} is not a function slug ([a-z0-9]{1,20}).`,
		);
	}
	return `NEON_FUNCTION_${slug.toUpperCase()}_BASE_URL` as FunctionBaseUrlKey<S>;
}

export function parseFunctionBaseUrlKey(key: string): string | null {
	const match = FUNCTION_BASE_URL_KEY.exec(key);
	return match ? match[1].toLowerCase() : null;
}

export function isFunctionBaseUrlKey(key: string): key is FunctionBaseUrlKey {
	return parseFunctionBaseUrlKey(key) !== null;
}

/** `all-live` lists deployed functions. Policy mode derives declared slugs from the connection host. */
export type FunctionUrlMode = "policy" | "all-live";

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

export interface NeonFunctionUrlEnv {
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

/** The tuple guard prevents a missing preview block from enabling functions. */
type HasFunctions<C extends Config> = [NonNullable<C["preview"]>] extends [
	never,
]
	? false
	: NonNullable<C["preview"]> extends { functions: infer F }
		? HasKeys<NonNullable<F>>
		: false;

type PreviewFunctionsOfConfig<C extends Config> = [
	NonNullable<C["preview"]>,
] extends [never]
	? Record<never, never>
	: NonNullable<C["preview"]> extends { functions: infer F }
		? F
		: Record<never, never>;

type FunctionSlugOfConfig<C extends Config> = Extract<
	keyof PreviewFunctionsOfConfig<C>,
	string
>;

export type NeonFunctionsEnv<C extends Config> = {
	[S in FunctionSlugOfConfig<C>]: NeonFunctionUrlEnv;
};

type FunctionBaseUrlKeyOf<C extends Config> =
	FunctionSlugOfConfig<C> extends infer S
		? S extends string
			? FunctionBaseUrlKey<S>
			: never
		: never;

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
 * - `functions` is added iff `config.preview.functions` declares at least one slug.
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
		: NoNamespace) &
	(HasFunctions<C> extends true
		? { functions: NeonFunctionsEnv<C> }
		: NoNamespace);

// ───────────────────────── env-var key filtering ─────────────────────────

/**
 * OS-level env-var keys grouped by the {@link NeonEnv} namespace they populate. Only the
 * **input** vars `parseEnv` validates are listed — the output-only aliases in
 * {@link NEON_ENV_VAR_KEYS} (`NEON_AI_GATEWAY_TOKEN`, …) are intentionally absent, so they
 * are not selectable in a `parseEnv(config, keys)` filter. Keep in sync with
 * {@link EnvKeyToProp}.
 */
interface EnvKeysByNamespace {
	postgres: "DATABASE_URL" | "DATABASE_URL_UNPOOLED";
	branch: "NEON_BRANCH";
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
	branch: NeonBranchEnv;
	auth: NeonAuthEnv;
	dataApi: NeonDataApiEnv;
	storage: NeonStorageEnv;
	aiGateway: NeonAiGatewayEnv;
}

/** OS-level env-var key → the camelCase property it sets on its namespace object. */
interface EnvKeyToProp {
	DATABASE_URL: "databaseUrl";
	DATABASE_URL_UNPOOLED: "databaseUrlUnpooled";
	NEON_BRANCH: "name";
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
	| EnvKeysByNamespace[keyof NeonEnv<C> & keyof EnvKeysByNamespace]
	| FunctionBaseUrlKeyOf<C>;

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
type SelectedFunctionKeys<K extends string> = Extract<K, FunctionBaseUrlKey>;

type FunctionSlugFromKey<K extends string> =
	K extends `NEON_FUNCTION_${infer S}_BASE_URL` ? Lowercase<S> : never;

type FunctionsFilteredEnv<K extends string> = [
	SelectedFunctionKeys<K>,
] extends [never]
	? unknown
	: {
			functions: {
				[P in SelectedFunctionKeys<K> as FunctionSlugFromKey<P>]: NeonFunctionUrlEnv;
			};
		};

type OptionalFunctionsFilteredEnv<K extends string> = [
	SelectedFunctionKeys<K>,
] extends [never]
	? unknown
	: {
			functions?: {
				[P in SelectedFunctionKeys<K> as FunctionSlugFromKey<P>]?: NeonFunctionUrlEnv;
			};
		};

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
} & FunctionsFilteredEnv<K>;

/**
 * A filtered result when the exact runtime contents of a key array are unknown. Both the
 * namespace and its selected properties are optional because the array may omit any member of
 * its element union, or be empty.
 */
type OptionalFilteredNeonEnv<K extends string> = {
	[N in keyof EnvKeysByNamespace as [
		Extract<K, EnvKeysByNamespace[N]>,
	] extends [never]
		? never
		: N]?: {
		[P in Extract<K, EnvKeysByNamespace[N]> as EnvKeyToProp[P &
			keyof EnvKeyToProp]]?: NamespaceEnv[N][EnvKeyToProp[P &
			keyof EnvKeyToProp] &
			keyof NamespaceEnv[N]];
	};
} & OptionalFunctionsFilteredEnv<K>;

/** Whether `T` is a union rather than one concrete type. */
type IsUnion<T, Whole = T> = T extends Whole
	? [Whole] extends [T]
		? false
		: true
	: never;

/** Whether any fixed tuple position can hold more than one key at runtime. */
type TupleHasUnion<T extends readonly unknown[]> = T extends readonly []
	? false
	: T extends readonly [infer Head, ...infer Tail extends readonly unknown[]]
		? true extends IsUnion<Head>
			? true
			: TupleHasUnion<Tail>
		: true;

/**
 * The sound result of selecting an array of OS-level env-var keys.
 *
 * Inline literal tuples remain exact. Widened arrays, rest tuples, and tuple positions whose
 * value is a union are conservative because their runtime contents may be any subset of the
 * element type. The leading conditional distributes unions of whole literal tuples, preserving
 * each exact alternative.
 */
export type SelectedNeonEnv<Keys extends readonly string[]> =
	Keys extends readonly string[]
		? number extends Keys["length"]
			? OptionalFilteredNeonEnv<Keys[number]>
			: TupleHasUnion<Keys> extends true
				? OptionalFilteredNeonEnv<Keys[number]>
				: FilteredNeonEnv<Keys[number]>
		: never;

type StorageCredentialEnvKey = "AWS_ACCESS_KEY_ID" | "AWS_SECRET_ACCESS_KEY";

type StorageKeyPairError = {
	readonly "fetchEnv keys must include AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY together": never;
};

type TupleDefinitelyContains<
	Keys extends readonly string[],
	Key extends string,
> = Keys extends readonly [
	infer Head extends string,
	...infer Tail extends readonly string[],
]
	? [Head] extends [Key]
		? true
		: TupleDefinitelyContains<Tail, Key>
	: false;

type TupleDefinitelyContainsStoragePair<Keys extends readonly string[]> =
	TupleDefinitelyContains<Keys, "AWS_ACCESS_KEY_ID"> extends true
		? TupleDefinitelyContains<Keys, "AWS_SECRET_ACCESS_KEY"> extends true
			? true
			: false
		: false;

/**
 * Reject a fixed key tuple that contains only one half of the storage credential. Dynamic
 * arrays are checked at runtime because their contents are not known to TypeScript.
 */
type InvalidStorageKeyTuple<Keys extends readonly string[]> =
	Keys extends unknown
		? number extends Keys["length"]
			? never
			: [Extract<Keys[number], StorageCredentialEnvKey>] extends [never]
				? never
				: TupleDefinitelyContainsStoragePair<Keys> extends true
					? never
					: Keys
		: never;

type StorageKeyPairConstraint<Keys extends readonly string[]> = [
	InvalidStorageKeyTuple<Keys>,
] extends [never]
	? unknown
	: StorageKeyPairError;

type FetchEnvKeysFromArgs<Args extends readonly unknown[]> = Args[0] extends {
	keys: infer Keys extends readonly string[];
}
	? Keys
	: never;

type StorageKeyPairArgsConstraint<Args extends readonly unknown[]> =
	StorageKeyPairConstraint<FetchEnvKeysFromArgs<Args>>;

/** Preserve the same pair rule for callers that explicitly provide the legacy `K` generic. */
type StorageKeyUnionConstraint<K extends string> = [
	Extract<K, StorageCredentialEnvKey>,
] extends [never]
	? unknown
	: StorageCredentialEnvKey extends K
		? unknown
		: StorageKeyPairError;

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
	 * Database name. When omitted, it is auto-picked: Neon's default `neondb` if present,
	 * else the only database on the branch. Throws {@link PlatformError} with
	 * `PLATFORM_AMBIGUOUS_BRANCH_AUTH` when the branch has several databases and none is
	 * `neondb` (pass `databaseName` to disambiguate), and `PLATFORM_BRANCH_NOT_FOUND` when
	 * the branch has no databases or the requested `databaseName` does not exist.
	 */
	databaseName?: string;
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
 * Pass `keys` to fetch only some of them — see the overload below.
 *
 * The package does **not** read `process.env`, mutate it, or touch the filesystem. Everything
 * it returns comes from the Neon API, so a value the API cannot produce (a one-time secret
 * issued to a previous call) is minted afresh rather than recovered. Callers that hold
 * persisted secrets and want to keep them use {@link fetchEnvReusingSecrets}, which decides
 * what is still valid and narrows this call's `keys` accordingly.
 */
export async function fetchEnv<
	const C extends Config,
	const Args extends readonly [
		options: FetchEnvOptions & {
			/**
			 * Fetch only these OS-level env vars, instead of everything the policy enables. The
			 * keys autocomplete from the policy ({@link SelectableEnvKey}), and the result is
			 * narrowed to match ({@link SelectedNeonEnv}). Inline literal arrays produce an exact
			 * result; runtime-built arrays make their possible namespaces and properties optional.
			 * `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` must be selected together.
			 *
			 * The point is not just a smaller result: **work is skipped too.** Leave out
			 * `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `NEON_AI_GATEWAY_TOKEN` and no branch
			 * credential is minted at all, so a caller that already holds valid secrets can refresh
			 * everything else without issuing a new one. The non-secret vars of the same features
			 * (`AWS_ENDPOINT_URL_S3`, `AWS_REGION`, `NEON_AI_GATEWAY_BASE_URL`) are not
			 * credential-backed and stay available on their own.
			 *
			 * The selection **intersects** with the policy rather than overriding it: naming a var
			 * the branch policy does not enable is not an error, it simply yields nothing.
			 */
			keys: readonly SelectableEnvKey<C>[];
		},
	],
>(
	config: C,
	...args: Args & StorageKeyPairArgsConstraint<NoInfer<Args>>
): Promise<SelectedNeonEnv<FetchEnvKeysFromArgs<NoInfer<Args>>>>;
export async function fetchEnv<
	const C extends Config,
	const K extends SelectableEnvKey<C> = never,
>(
	config: C,
	options: [NoInfer<K>] extends [never]
		? never
		: FetchEnvOptions & {
				keys: readonly NoInfer<K>[];
			} & StorageKeyUnionConstraint<NoInfer<K>>,
): Promise<FilteredNeonEnv<NoInfer<K>>>;
export async function fetchEnv<const C extends Config>(
	config: C,
	options: FetchEnvOptions & { keys?: never },
): Promise<NeonEnv<C>>;
/** Diagnostic-only fallback: valid keyed calls resolve through the exact overload above. */
export async function fetchEnv<
	const C extends Config,
	const Keys extends readonly SelectableEnvKey<C>[],
>(
	config: C,
	options: FetchEnvOptions & { keys: Keys } & StorageKeyPairError,
): Promise<never>;
export async function fetchEnv(
	config: Config,
	options: FetchEnvOptions & { keys?: readonly string[] },
): Promise<unknown> {
	if (options.keys) assertStorageCredentialKeyPair(options.keys);
	return fetchEnvKeys(config, options, options.keys ?? null);
}

function assertStorageCredentialKeyPair(keys: readonly string[]): void {
	const hasAccessKey = keys.includes(NEON_ENV_VAR_KEYS.storage.accessKeyId);
	const hasSecretKey = keys.includes(
		NEON_ENV_VAR_KEYS.storage.secretAccessKey,
	);
	if (hasAccessKey === hasSecretKey) return;
	throw new TypeError(
		"fetchEnv: AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY must be selected together. Pass both in `keys`, or omit both.",
	);
}

/** Fail loudly when selected-key dependency planning and execution disagree. */
function requiredValue<T>(value: T | null, description: string): T {
	if (value === null) {
		throw new Error(`fetchEnv: missing ${description}.`);
	}
	return value;
}

/**
 * The {@link fetchEnv} body, with the key selection as a plain argument and no generic
 * narrowing. Exists for callers that compute the selection at runtime — notably
 * {@link fetchEnvReusingSecrets}, which decides which keys it still needs by checking the
 * branch — since the public overload's `keys` is bound to a literal union those callers cannot
 * produce without asserting.
 *
 * `keys === null` selects everything the policy enables.
 */
export async function fetchEnvKeys(
	config: Config,
	options: FetchEnvKeysOptions,
	keys: readonly string[] | null,
): Promise<ResolvedNeonEnv> {
	return (await fetchEnvKeysState(config, options, keys)).env;
}

export type FetchEnvKeysState = {
	env: ResolvedNeonEnv;
	/** Prevents endpoint failure from being mistaken for a confirmed empty function list. */
	functionUrlsUnavailable: boolean;
};

export type FetchEnvKeysOptions = FetchEnvOptions & {
	functionUrls?: FunctionUrlMode;
	/**
	 * Keys to skip even when {@link fetchEnvKeys} is unscoped (`keys === null`).
	 * {@link fetchEnvReusingSecrets} uses this to keep already-verified secrets
	 * without converting an unscoped fetch into a static policy-key list — that
	 * list cannot name `NEON_FUNCTION_*_BASE_URL`, so it would drop function URLs.
	 */
	omitKeys?: readonly string[];
	/**
	 * Skip a second `listBranchFunctions` when the caller already listed.
	 * `--service functions` uses this so a later `FeatureUnavailable` cannot be
	 * swallowed as `skipped`.
	 */
	listedFunctions?: ReadonlyArray<{ slug: string; invocationUrl: string }>;
};

export async function fetchEnvKeysState(
	config: Config,
	options: FetchEnvKeysOptions,
	keys: readonly string[] | null,
): Promise<FetchEnvKeysState> {
	const api = options.api ?? createApiFromOptions(options);
	const projectId = options.projectId;
	const { branch, desired } = await resolveBranchPolicy(config, options, api);

	const selection = keys ? new Set<string>(keys) : null;
	const omitted = new Set(options.omitKeys ?? []);
	const wants = (key: string): boolean =>
		!omitted.has(key) && (selection === null || selection.has(key));

	const result: ResolvedNeonEnv = {};
	const K = NEON_ENV_VAR_KEYS;
	const wantsPooled = wants(K.postgres.databaseUrl);
	const wantsUnpooled = wants(K.postgres.databaseUrlUnpooled);
	const wantsAuth =
		desired.authEnabled && (wants(K.auth.baseUrl) || wants(K.auth.jwksUrl));
	const wantsDataApi = desired.dataApiEnabled && wants(K.dataApi.url);
	const gatewayEnabled = desired.preview?.aiGatewayEnabled ?? false;
	const functionUrlMode = options.functionUrls ?? "policy";
	const declaredSlugs = (desired.preview?.functions ?? []).map(
		(fn) => fn.slug,
	);
	const selectedFunctionKeys =
		selection === null ? [] : [...selection].filter(isFunctionBaseUrlKey);
	const constructSlugs = functionUrlSlugsToConstruct({
		functionUrlMode,
		selection,
		declaredSlugs,
		selectedFunctionKeys,
		wants,
	});
	const needsUnpooled =
		wantsUnpooled ||
		(gatewayEnabled && wants(K.aiGateway.baseUrl)) ||
		constructSlugs.length > 0;
	const needsConnectionTarget = wantsPooled || needsUnpooled;
	const needsDatabase = needsConnectionTarget || wantsDataApi;
	const [roles, databases] = await Promise.all([
		needsConnectionTarget
			? api.listBranchRoles(projectId, branch.id)
			: Promise.resolve([]),
		needsDatabase
			? api.listBranchDatabases(projectId, branch.id)
			: Promise.resolve([]),
	]);

	const databaseName = needsDatabase
		? pickDatabaseName(databases, branch, options.databaseName)
		: null;
	const connectionTarget = needsConnectionTarget
		? {
				roleName: pickRoleName(roles, branch, options.roleName),
				databaseName: requiredValue(
					databaseName,
					"database for a selected connection URI",
				),
			}
		: null;
	const getConnectionUri = (pooled: boolean) => {
		const target = requiredValue(
			connectionTarget,
			"role and database for a selected connection URI",
		);
		return api.getConnectionUri(projectId, {
			branchId: branch.id,
			...target,
			pooled,
		});
	};

	// Fetch only what the selected keys depend on. The direct Postgres URI also derives the
	// AI Gateway host, while Auth, storage, branch identity, and gateway tokens need no
	// Postgres metadata. Auth key fields are only returned at integration creation time; for
	// Better Auth they may legitimately be empty, so they can come back as empty strings.
	const [pooled, unpooled, authSnapshot, dataApiSnapshot] = await Promise.all(
		[
			wantsPooled ? getConnectionUri(true) : Promise.resolve(null),
			needsUnpooled ? getConnectionUri(false) : Promise.resolve(null),
			wantsAuth
				? api.getNeonAuth(projectId, branch.id)
				: Promise.resolve(null),
			wantsDataApi
				? api.getNeonDataApi(
						projectId,
						branch.id,
						requiredValue(
							databaseName,
							"database for the selected Data API URL",
						),
					)
				: Promise.resolve(null),
		],
	);

	const postgres: Partial<NeonPostgresEnv> = {};
	if (wantsPooled) {
		postgres.databaseUrl = requiredValue(
			pooled,
			"pooled connection URI response",
		).uri;
	}
	if (wantsUnpooled) {
		postgres.databaseUrlUnpooled = requiredValue(
			unpooled,
			"direct connection URI response",
		).uri;
	}
	if (Object.keys(postgres).length > 0) result.postgres = postgres;

	// Branch identity, mirroring what the Functions runtime injects on every branch. Surfaced
	// as `NEON_BRANCH` so local dev (`neon dev` / `neon-env run` / `env pull`) matches the
	// deployed runtime. Uses the branch name.
	if (wants(K.branch.name)) {
		result.branch = { name: branch.name } satisfies NeonBranchEnv;
	}

	if (wantsAuth) {
		if (!authSnapshot) {
			throw new PlatformError(
				ErrorCode.NotFound,
				[
					`fetchEnv: branch policy enables auth but no Neon Auth integration is enabled on branch ${branch.name} (${branch.id}).`,
					"Enable it via `apply(config, { projectId, branchId })` (or `npx neon …`), in the Neon Console — then re-run fetchEnv. Or return auth.enabled=false.",
				].join(" "),
				{
					details: { projectId, branchId: branch.id },
				},
			);
		}
		const auth: Partial<NeonAuthEnv> = {};
		if (wants(K.auth.baseUrl)) auth.baseUrl = authSnapshot.baseUrl ?? "";
		if (wants(K.auth.jwksUrl)) auth.jwksUrl = authSnapshot.jwksUrl ?? "";
		result.auth = auth;
	}

	if (wantsDataApi) {
		if (!dataApiSnapshot) {
			const selectedDatabase = requiredValue(
				databaseName,
				"database for the selected Data API URL",
			);
			throw new PlatformError(
				ErrorCode.NotFound,
				[
					`fetchEnv: branch policy enables dataApi but no Data API integration is enabled on branch ${branch.name} (${branch.id}) database ${selectedDatabase}.`,
					"Enable it via `apply(config, { projectId, branchId })` or in the Neon Console — then re-run fetchEnv. Or return dataApi.enabled=false.",
				].join(" "),
				{
					details: {
						projectId,
						branchId: branch.id,
						databaseName: selectedDatabase,
					},
				},
			);
		}
		result.dataApi = { url: dataApiSnapshot.url } satisfies NeonDataApiEnv;
	}

	// Object storage + AI Gateway (Preview). A single branch credential backs whichever of
	// these the policy enables; functions never force one but ride along on its scopes. None
	// of this runs when the policy enables neither, so the Postgres / Auth / Data API path
	// never touches the credentials/storage endpoints (and keeps working on production, where
	// they may not exist yet).
	const storageEnabled = (desired.preview?.buckets.length ?? 0) > 0;
	const wantsStorage =
		storageEnabled &&
		(wants(K.storage.accessKeyId) ||
			wants(K.storage.secretAccessKey) ||
			wants(K.storage.endpoint) ||
			wants(K.storage.region));
	const wantsGateway =
		gatewayEnabled &&
		(wants(K.aiGateway.apiKey) || wants(K.aiGateway.baseUrl));
	// A credential is minted only for its *secrets*. The endpoint, region and gateway host
	// are plain branch metadata, so selecting only those touches no credential at all — which
	// is how a caller holding valid secrets refreshes the rest without issuing a new one.
	const wantsStorageCredential =
		storageEnabled &&
		(wants(K.storage.accessKeyId) || wants(K.storage.secretAccessKey));
	const wantsGatewayCredential = gatewayEnabled && wants(K.aiGateway.apiKey);
	const wantsCredential = wantsStorageCredential || wantsGatewayCredential;

	if (wantsStorage || wantsGateway) {
		// Read the branch's storage settings *before* minting: a policy that declares buckets
		// on a branch without storage has to fail without having spent a credential on a
		// resolve that cannot succeed.
		let storage: NeonBranchStorageSnapshot | null = null;
		if (wantsStorage) {
			storage = await api.getProjectBranchStorage(projectId, branch.id);
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
		}

		const secrets = wantsCredential
			? await mintBranchCredential({
					api,
					projectId,
					branchId: branch.id,
					branchName: branch.name,
					scopes: previewCredentialScopes(desired.preview, {
						storage: wantsStorageCredential,
						aiGateway: wantsGatewayCredential,
					}),
				})
			: null;

		if (storage) {
			const storageEnv: Partial<NeonStorageEnv> = {};
			if (secrets && wants(K.storage.accessKeyId)) {
				storageEnv.accessKeyId = secrets.accessKeyId;
			}
			if (secrets && wants(K.storage.secretAccessKey)) {
				storageEnv.secretAccessKey = secrets.secretAccessKey;
			}
			if (wants(K.storage.endpoint)) {
				storageEnv.endpoint = storage.s3Endpoint;
			}
			if (wants(K.storage.region)) storageEnv.region = storage.region;
			result.storage = storageEnv;
		}
		if (wantsGateway) {
			const gateway: Partial<NeonAiGatewayEnv> = {};
			if (secrets && wants(K.aiGateway.apiKey)) {
				gateway.apiKey = secrets.apiToken;
			}
			if (wants(K.aiGateway.baseUrl)) {
				// Bare branch-scoped gateway host derived from the branch's connection URI —
				// not the control-plane API origin (which doesn't serve the gateway). Clients
				// append the dialect route (/v1, /openai/v1, /anthropic/v1) themselves.
				gateway.baseUrl = aiGatewayBaseUrl(
					branch.id,
					requiredValue(
						unpooled,
						"direct connection URI for the selected AI Gateway base URL",
					).uri,
				);
			}
			result.aiGateway = gateway;
		}
	}

	const wantsAnyFunctionUrl =
		selection === null || selectedFunctionKeys.length > 0;
	const functions: Record<string, NeonFunctionUrlEnv> = {};
	let functionUrlsUnavailable = false;

	if (functionUrlMode === "all-live" && wantsAnyFunctionUrl) {
		const listed =
			options.listedFunctions === undefined
				? await listFunctionInvocationUrls(api, projectId, branch.id)
				: listedFromSnapshots(options.listedFunctions);
		if (listed.status === "unavailable") {
			if (selection === null) functionUrlsUnavailable = true;
		} else {
			for (const fn of listed.functions) {
				if (!wants(functionBaseUrlKey(fn.slug))) continue;
				functions[fn.slug] = { baseUrl: fn.invocationUrl };
			}
		}
	}

	const missingConstructSlugs = constructSlugs.filter(
		(slug) => functions[slug] === undefined,
	);
	if (missingConstructSlugs.length > 0) {
		const uri = requiredValue(
			unpooled,
			"direct connection URI for function invocation URLs",
		).uri;
		for (const slug of missingConstructSlugs) {
			functions[slug] = {
				baseUrl: functionInvocationUrl(branch.id, slug, uri),
			};
		}
	}

	assertSelectedFunctionUrls(selectedFunctionKeys, functions);
	if (Object.keys(functions).length > 0) result.functions = functions;

	return { env: result, functionUrlsUnavailable };
}

function functionUrlSlugsToConstruct(args: {
	functionUrlMode: FunctionUrlMode;
	selection: Set<string> | null;
	declaredSlugs: readonly string[];
	selectedFunctionKeys: readonly string[];
	wants: (key: string) => boolean;
}): string[] {
	const slugs: string[] = [];
	if (args.functionUrlMode === "policy" && args.selection === null) {
		for (const slug of args.declaredSlugs) {
			if (args.wants(functionBaseUrlKey(slug))) slugs.push(slug);
		}
		return slugs;
	}
	for (const key of args.selectedFunctionKeys) {
		const slug = parseFunctionBaseUrlKey(key);
		if (slug !== null) slugs.push(slug);
	}
	return slugs;
}

function listedFromSnapshots(
	snapshots: ReadonlyArray<{ slug: string; invocationUrl: string }>,
): {
	status: "ok";
	functions: Array<{ slug: string; invocationUrl: string }>;
} {
	const functions = snapshots
		.filter((fn) => fn.invocationUrl !== "")
		.map((fn) => ({
			slug: fn.slug,
			invocationUrl: fn.invocationUrl,
		}))
		.sort((left, right) => left.slug.localeCompare(right.slug));
	return { status: "ok", functions };
}

function assertSelectedFunctionUrls(
	keys: readonly string[],
	functions: Record<string, NeonFunctionUrlEnv>,
): void {
	for (const key of keys) {
		const slug = parseFunctionBaseUrlKey(key);
		if (slug === null || functions[slug] === undefined) {
			throw new Error(`fetchEnv: missing ${key}.`);
		}
	}
}

async function listFunctionInvocationUrls(
	api: NeonApi,
	projectId: string,
	branchId: string,
): Promise<
	| {
			status: "ok";
			functions: Array<{ slug: string; invocationUrl: string }>;
	  }
	| { status: "unavailable"; error: PlatformError }
> {
	try {
		const snapshots = await api.listBranchFunctions(projectId, branchId);
		return listedFromSnapshots(snapshots);
	} catch (error) {
		if (
			isPlatformError(error) &&
			error.code === ErrorCode.FeatureUnavailable
		) {
			return { status: "unavailable", error };
		}
		throw error;
	}
}

/**
 * Resolve the target branch and evaluate the policy against it — the first thing any
 * branch-scoped operation needs. Shared by {@link fetchEnv} and {@link fetchEnvReusingSecrets}
 * so the two agree on which branch they're talking about and what it has enabled.
 */
export async function resolveBranchPolicy(
	config: Config,
	options: Pick<FetchEnvOptions, "projectId" | "branch" | "branchId">,
	api: NeonApi,
): Promise<{
	branch: NeonBranchSnapshot;
	desired: ReturnType<typeof resolveConfig>;
}> {
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
	return { branch, desired };
}

/**
 * Scopes the branch credential should carry for a resolved branch policy and optional key
 * selection. Only object storage and the AI Gateway *require* a credential; functions never
 * force one, but `functions:invoke` rides along when another selected feature mints one.
 */
export function previewCredentialScopes(
	preview: ResolvedPreviewConfig | undefined,
	selected?: { storage: boolean; aiGateway: boolean },
): CredentialScope[] {
	if (!preview) return [];
	const storage = preview.buckets.length > 0 && (selected?.storage ?? true);
	const aiGateway = preview.aiGatewayEnabled && (selected?.aiGateway ?? true);
	if (!storage && !aiGateway) return [];
	return deriveCredentialScopes({
		storage,
		aiGateway,
		functions: preview.functions.length > 0,
	});
}

/** The `name` this tool stamps on every credential it mints, so it can recognize its own. */
export function credentialName(branchName: string): string {
	return `neon-env ${branchName}`;
}

/** The env-var keys a branch credential's secrets surface under, in emit order. */
export function credentialEnvKeys(flags: {
	storage: boolean;
	aiGateway: boolean;
}): string[] {
	return [
		...(flags.storage
			? [
					NEON_ENV_VAR_KEYS.storage.accessKeyId,
					NEON_ENV_VAR_KEYS.storage.secretAccessKey,
				]
			: []),
		...(flags.aiGateway ? [NEON_ENV_VAR_KEYS.aiGateway.apiKey] : []),
	];
}

/**
 * Every OS-level env var a resolved branch policy produces, in emit order. Lets a caller
 * subtract the ones it already holds and pass the rest as {@link fetchEnv}'s `keys`, without
 * re-deriving which vars a policy implies.
 */
export function policyEnvKeys(
	desired: ReturnType<typeof resolveConfig>,
): string[] {
	const K = NEON_ENV_VAR_KEYS;
	return [
		K.postgres.databaseUrl,
		K.postgres.databaseUrlUnpooled,
		K.branch.name,
		...(desired.authEnabled ? [K.auth.baseUrl, K.auth.jwksUrl] : []),
		...(desired.dataApiEnabled ? [K.dataApi.url] : []),
		...((desired.preview?.buckets.length ?? 0) > 0
			? [
					K.storage.accessKeyId,
					K.storage.secretAccessKey,
					K.storage.endpoint,
					K.storage.region,
				]
			: []),
		...(desired.preview?.aiGatewayEnabled
			? [K.aiGateway.apiKey, K.aiGateway.baseUrl]
			: []),
	];
}

/**
 * Mint the branch credential backing object storage / the AI Gateway.
 *
 * `api_token` and `s3_secret_access_key` come back **exactly once** — they are not stored
 * server-side and the list endpoint returns metadata only — so the caller's copy is the only
 * copy. That is why {@link fetchEnv} mints rather than fetches: there is nothing to fetch. A
 * caller that already holds a valid copy should leave the secret keys out of `keys` (see
 * {@link fetchEnvReusingSecrets}) instead of minting one it will discard.
 */
async function mintBranchCredential(args: {
	api: NeonApi;
	projectId: string;
	branchId: string;
	branchName: string;
	scopes: CredentialScope[];
}): Promise<{
	accessKeyId: string;
	secretAccessKey: string;
	apiToken: string;
}> {
	const minted = await args.api.createCredential(
		args.projectId,
		args.branchId,
		{
			scopes: args.scopes,
			principalType: "user",
			name: credentialName(args.branchName),
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
 *
 * Function invocation URLs use the same suffix: `<branchId>-<slug>.compute.<suffix>`.
 */
function connectionHostSuffix(connectionUri: string): string {
	let connectionHost = "";
	try {
		connectionHost = new URL(connectionUri).hostname;
	} catch {
		connectionHost = "";
	}
	// Drop the endpoint label (first segment, e.g. `ep-x` / `ep-x-pooler`), keeping the rest
	// of the host verbatim — including any infra cell prefix (`c-N.`) cell-routed hosts use:
	// `[c-N.]<region>.<cloud>.neon.<tld>`.
	return connectionHost.split(".").slice(1).join(".");
}

function aiGatewayHost(branchId: string, connectionUri: string): string {
	return `${branchId}-api.ai.${connectionHostSuffix(connectionUri)}`;
}

/** Derived from the connection URI so undeployed functions have a cell-routed URL. */
function functionInvocationUrl(
	branchId: string,
	slug: string,
	connectionUri: string,
): string {
	const suffix = connectionHostSuffix(connectionUri);
	if (suffix === "") {
		throw new Error(
			`fetchEnv: cannot derive the invocation URL for function "${slug}": ` +
				"the direct connection URI has no host suffix.",
		);
	}
	return `https://${branchId}-${slug}.compute.${suffix}/`;
}

/** The AI Gateway's bare base URL (`NEON_AI_GATEWAY_BASE_URL`) on the branch gateway host. */
function aiGatewayBaseUrl(branchId: string, connectionUri: string): string {
	return `https://${aiGatewayHost(branchId, connectionUri)}`;
}

export function createApiFromOptions(options: FetchEnvOptions): NeonApi {
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

	// Prefer Neon's default `neondb`. On the common "added a second database" branch this
	// auto-picks it, so a lone or `neondb`-including branch resolves without asking.
	const neondb = databases.find((d) => d.name === NEON_DEFAULT_DATABASE);
	if (neondb) return neondb.name;

	if (databases.length === 1) return databases[0].name;

	// Several databases and no `neondb` to fall back on. Auto-picking any of them would be
	// perceived as random and is bad DX, so fail loudly and let the caller disambiguate.
	throw new PlatformError(
		ErrorCode.AmbiguousBranchAuth,
		[
			`fetchEnv: branch ${branch.name} (${branch.id}) has ${databases.length} databases and none is named "${NEON_DEFAULT_DATABASE}"; cannot auto-pick.`,
			`Rename one to "${NEON_DEFAULT_DATABASE}" or keep a single database on the branch (or, when calling fetchEnv directly, pass \`databaseName\`). Available: ${databases.map((d) => d.name).join(", ")}.`,
		].join(" "),
		{
			details: {
				branchId: branch.id,
				availableDatabases: databases.map((d) => d.name),
			},
		},
	);
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
export function toEntries(env: ResolvedNeonEnv): Record<string, string> {
	const out: Record<string, string> = {};
	const put = (key: string, value: string | undefined): void => {
		if (value !== undefined) out[key] = value;
	};
	const K = NEON_ENV_VAR_KEYS;
	put(K.postgres.databaseUrl, env.postgres?.databaseUrl);
	put(K.postgres.databaseUrlUnpooled, env.postgres?.databaseUrlUnpooled);
	put(K.branch.name, env.branch?.name);
	put(K.auth.baseUrl, env.auth?.baseUrl);
	put(K.auth.jwksUrl, env.auth?.jwksUrl);
	put(K.dataApi.url, env.dataApi?.url);
	put(K.storage.accessKeyId, env.storage?.accessKeyId);
	put(K.storage.secretAccessKey, env.storage?.secretAccessKey);
	put(K.storage.endpoint, env.storage?.endpoint);
	put(K.storage.region, env.storage?.region);
	// Neon-branded gateway vars only: the bearer and the bare branch gateway host
	// (scheme://host, no path) — the @neon/ai-sdk-provider appends the dialect route
	// (/v1, /openai/v1, /anthropic/v1) itself (https://github.com/vercel/ai/pull/15997).
	put(K.aiGateway.apiKey, env.aiGateway?.apiKey);
	put(K.aiGateway.baseUrl, env.aiGateway?.baseUrl);
	if (env.functions) {
		for (const slug of Object.keys(env.functions).sort()) {
			put(functionBaseUrlKey(slug), env.functions[slug]?.baseUrl);
		}
	}
	return out;
}

/**
 * Any resolved env {@link toEntries} can project: a full {@link NeonEnv}, or the narrowed
 * result of a `keys`-filtered {@link fetchEnv} / {@link parseEnv} call. Every namespace and
 * property is optional so a filtered result — which legitimately carries only what was asked
 * for — projects to exactly the vars it holds instead of failing to type-check.
 */
export type ResolvedNeonEnv = {
	[N in keyof NamespaceEnv]?: Partial<NamespaceEnv[N]>;
} & {
	functions?: Record<string, NeonFunctionUrlEnv>;
};
