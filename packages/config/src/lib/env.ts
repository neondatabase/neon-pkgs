/**
 * The **type** of a resolved Neon environment for a given branch policy — `NeonEnv<Config>`
 * and its per-namespace parts.
 *
 * This is the canonical home for the env *shape*: it is a pure, runtime-free type derived
 * entirely from a {@link Config} (which namespaces are present is a direct read of the
 * policy's static `auth` / `dataApi` / `preview`). The companion **`@neondatabase/env`**
 * package owns the runtime that *produces* a value of this type (`fetchEnv` / `parseEnv`) and
 * re-exports these types so its public surface is unchanged.
 *
 * Keeping the type here (rather than in `@neondatabase/env`) means `@neondatabase/config` can
 * type a `neon.ts` `hooks` `after` context as the exact `NeonEnv<typeof config>` without a
 * `config` → `env` dependency cycle (`env` already depends on `config`).
 */
import type { Config, ServiceEnabled } from "./types.js";

/**
 * Branch identity for the resolved branch. Always present on a `fetchEnv` result; on a
 * `parseEnv` result present only when `NEON_BRANCH` was injected. `name` is the branch
 * **name** (e.g. `main`, `preview/foo`).
 */
export interface NeonBranchEnv {
	name: string;
}

/** Postgres connection strings for the branch. */
export interface NeonPostgresEnv {
	/**
	 * Pooled connection string (via Neon's PgBouncer pooler). The right default for
	 * serverless drivers (`@neondatabase/serverless`, edge runtimes, Postgres.js, …).
	 */
	databaseUrl: string;
	/**
	 * Direct (unpooled) connection string. Use this when you need session-level features
	 * (`LISTEN`/`NOTIFY`, prepared statements across calls, transactions spanning
	 * round-trips) that PgBouncer's transaction-mode pooling drops — and for migrations.
	 */
	databaseUrlUnpooled: string;
}

/**
 * Neon Auth integration bits for the branch. Present on {@link NeonEnv} only when the policy
 * enables `auth`. `baseUrl` doubles as the publishable client identifier; `jwksUrl` verifies
 * tokens Neon Auth issues.
 */
export interface NeonAuthEnv {
	baseUrl: string;
	jwksUrl: string;
}

/** Neon Data API integration bits. Present only when the policy enables `dataApi`. */
export interface NeonDataApiEnv {
	url: string;
}

/**
 * S3-compatible object-storage access for the branch (Preview). Present only when the policy
 * declares `preview.buckets`. Projects to the AWS SDK's standard env (`AWS_ACCESS_KEY_ID`,
 * `AWS_SECRET_ACCESS_KEY`, `AWS_ENDPOINT_URL_S3`, `AWS_REGION`). Neon's storage gateway always
 * requires path-style addressing, so set `forcePathStyle: true` on your S3 client.
 */
export interface NeonStorageEnv {
	accessKeyId: string;
	secretAccessKey: string;
	/** S3-compatible endpoint URL for the branch. */
	endpoint: string;
	/** AWS region string (e.g. `us-east-2`). */
	region: string;
}

/**
 * AI Gateway access for the branch (Preview). Present only when the policy enables
 * `preview.aiGateway`. Projects to the OpenAI SDK's standard env (`OPENAI_API_KEY`,
 * `OPENAI_BASE_URL`).
 */
export interface NeonAiGatewayEnv {
	apiKey: string;
	baseUrl: string;
}

/**
 * Empty record used as the "absent" branch of the conditional namespace adds below.
 * `Record<never, never>` is the no-op for intersection (the biome-approved empty object).
 */
type NoNamespace = Record<never, never>;

/** True when `T` has at least one known key; `false` for `{}` / `never`. */
type HasKeys<T> = [keyof T] extends [never] ? false : true;

/**
 * Whether the policy's static `preview` block declares at least one bucket. The leading
 * `[never]` guard is load-bearing: with no `preview`, `NonNullable<C["preview"]>` is `never`,
 * which would otherwise vacuously match the probe and wrongly add the namespace.
 */
type HasBuckets<C extends Config> = [NonNullable<C["preview"]>] extends [never]
	? false
	: NonNullable<C["preview"]> extends { buckets: infer B }
		? HasKeys<NonNullable<B>>
		: false;

/**
 * Whether the policy's static `preview` block enables the AI Gateway. Same `[never]` guard as
 * {@link HasBuckets} — a naked `never` in the `extends` would distribute and collapse the whole
 * intersection to `never`.
 */
type AiGatewayOn<C extends Config> = [NonNullable<C["preview"]>] extends [never]
	? false
	: NonNullable<C["preview"]> extends { aiGateway: infer A }
		? ServiceEnabled<NonNullable<A>>
		: false;

/**
 * Static, namespaced shape of a resolved Neon environment, generic over the {@link Config} so
 * the type system knows exactly which optional namespaces are present:
 *
 * - `postgres` is always present.
 * - `auth` iff `config.auth` is statically enabled.
 * - `dataApi` iff `config.dataApi` is statically enabled.
 * - `storage` iff `config.preview.buckets` declares at least one bucket.
 * - `aiGateway` iff `config.preview.aiGateway` is statically enabled.
 *
 * Reuses config's {@link ServiceEnabled} for the toggle → boolean read, so policy gating is
 * identical to the rest of the config surface.
 */
export type NeonEnv<C extends Config = Config> = {
	postgres: NeonPostgresEnv;
	/**
	 * Branch identity (`NEON_BRANCH`). Optional because `parseEnv` only surfaces it when the
	 * var was injected; `fetchEnv` always populates it.
	 */
	branch?: NeonBranchEnv;
} & (ServiceEnabled<NonNullable<C["auth"]>> extends true
	? { auth: NeonAuthEnv }
	: NoNamespace) &
	(ServiceEnabled<NonNullable<C["dataApi"]>> extends true
		? { dataApi: NeonDataApiEnv }
		: NoNamespace) &
	(HasBuckets<C> extends true ? { storage: NeonStorageEnv } : NoNamespace) &
	(AiGatewayOn<C> extends true
		? { aiGateway: NeonAiGatewayEnv }
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
 * The extra `function` namespace added to a `parseEnv` result when called with a function
 * slug scope: the declared env-var keys for that function, each resolved to a `string`.
 */
export type NeonFunctionEnv<C extends Config, S extends string> = {
	function: Record<FunctionEnvKeysOf<C, S>, string>;
};
