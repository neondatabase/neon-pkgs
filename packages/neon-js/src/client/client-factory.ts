import {
	createInternalNeonAuth,
	type NeonAuthAdapter,
	type NeonAuthConfig,
} from "@neon/auth";
import type { BetterAuthReactAdapterInstance } from "@neon/auth/react/adapters";
import type {
	BetterAuthVanillaAdapterInstance,
	SupabaseAuthAdapterInstance,
} from "@neon/auth/vanilla/adapters";
import {
	fetchWithToken,
	NeonPostgrestClient,
	type NeonPostgrestClientConstructorOptions,
} from "@neon/postgrest-js";
import {
	buildNeonJsClientInfo,
	X_NEON_CLIENT_INFO_HEADER,
} from "../utils/client-info";
import { type DeriveNeonUrls, defaultDeriveNeonUrls } from "./derive-urls";
import {
	type DefaultSchemaName,
	NeonClient,
	type NeonClientConstructorOptions,
} from "./neon-client";

/**
 * Auth configuration for createClient
 */
export type CreateClientAuthConfig<T extends NeonAuthAdapter> = {
	/** The auth service URL */
	url: string;
} & NeonAuthConfig<T>;

/**
 * Data API configuration for createClient
 */
export type CreateClientDataApiConfig<
	SchemaName,
	TAuth extends NeonAuthAdapter,
> = {
	/** The Data API URL */
	url: string;
	/** Additional client options */
	options?: Omit<
		NeonClientConstructorOptions<SchemaName, TAuth>,
		"dataApiUrl" | "authClient"
	>["options"];
};

/**
 * Configuration for createClient
 */
export type CreateClientConfig<SchemaName, T extends NeonAuthAdapter> = {
	/** Auth service configuration */
	auth: CreateClientAuthConfig<T>;
	/** Data API configuration */
	dataApi: CreateClientDataApiConfig<SchemaName, T>;
};

/**
 * Returns a valid JWT for the current user, or `null` if there is no session.
 *
 * Called lazily on every Data API request. Wire this to your own identity
 * provider — e.g. Clerk's `getToken()` or Auth0's `getAccessTokenSilently()`.
 * Neon validates the returned token against the JWKS URL configured for the
 * provider.
 */
export type NeonDataApiTokenProvider = () => Promise<string | null>;

/**
 * Data API configuration for the external-auth-provider form of createClient.
 *
 * Same as {@link CreateClientDataApiConfig} but carries a `getToken` function
 * instead of relying on a Neon Auth service.
 */
export type CreateClientExternalDataApiConfig<SchemaName> =
	CreateClientDataApiConfig<SchemaName, NeonAuthAdapter> & {
		/** Token provider consulted on every Data API request. */
		getToken: NeonDataApiTokenProvider;
	};

/**
 * Configuration for the external-auth-provider form of createClient.
 *
 * Use this when authentication is handled by your own identity provider
 * (Clerk, Auth0, …) rather than Neon Auth: omit the `auth` block entirely and
 * supply `dataApi.getToken`. No Neon Auth client is created, and the returned
 * client is a plain {@link NeonPostgrestClient} (no `.auth` property).
 */
export type CreateClientExternalConfig<SchemaName> = {
	/** External providers do not use a Neon Auth service. */
	auth?: never;
	/** Data API configuration, including your token provider. */
	dataApi: CreateClientExternalDataApiConfig<SchemaName>;
};

/**
 * Factory function to create NeonClient with seamless auth integration.
 *
 * @param config - Configuration with auth and dataApi sections
 * @returns NeonClient instance with auth-aware fetch wrapper
 * @throws AuthRequiredError when making requests without authentication
 *
 * @example
 * ```typescript
 * // Simple usage with default BetterAuthVanillaAdapter
 * import { createClient } from '@neon/neon-js';
 *
 * const client = createClient({
 *   auth: { url: 'https://auth.example.com' },
 *   dataApi: { url: 'https://data-api.example.com/rest/v1' },
 * });
 *
 * // Better Auth API
 * await client.auth.signIn.email({ email, password });
 *
 * // Database queries (automatic token injection)
 * const { data: items } = await client.from('items').select();
 * ```
 *
 * @example
 * ```typescript
 * // With SupabaseAuthAdapter for Supabase-compatible API
 * import { createClient, SupabaseAuthAdapter } from '@neon/neon-js';
 *
 * const client = createClient({
 *   auth: {
 *     adapter: SupabaseAuthAdapter,
 *     url: 'https://auth.example.com',
 *   },
 *   dataApi: {
 *     url: 'https://data-api.example.com/rest/v1',
 *   },
 * });
 *
 * // Supabase-compatible auth methods
 * await client.auth.signInWithPassword({ email, password });
 * ```
 *
 * @example
 * ```typescript
 * // Single base URL — auth and Data API URLs are derived automatically.
 * const client = createClient(
 *   'https://ep-xxx.c-2.us-east-2.aws.neon.build/dbname'
 * );
 * ```
 *
 * @example
 * ```typescript
 * // External auth provider (Clerk, Auth0, …): omit `auth` and supply a
 * // `getToken` function. The returned client has no `.auth` property.
 * const client = createClient({
 *   dataApi: {
 *     url: 'https://data-api.example.com/rest/v1',
 *     getToken: async () => await yourAuthProvider.getToken(),
 *   },
 * });
 *
 * const { data: items } = await client.from('items').select();
 * ```
 */

/**
 * The value `SupabaseAuthAdapter()` and friends return: a builder that `createClient`
 * invokes with the auth URL. Distinct from the adapter instance it produces.
 */
type AdapterBuilder<T extends NeonAuthAdapter> = NonNullable<
	NeonAuthConfig<T>["adapter"]
>;

/**
 * Helper type to create NeonClient with proper schema resolution.
 * Uses 'public' as the default schema since it's the most common case.
 */
type CreateClientResult<
	Database,
	TAdapter extends NeonAuthAdapter,
> = NeonClient<Database, DefaultSchemaName<Database>, TAdapter>;

// Overload: External auth provider (no Neon Auth) — returns a plain
// NeonPostgrestClient with no `.auth` property. Listed first so its `auth?:
// never` shape is matched before the auth-required object overloads.
// biome-ignore lint/suspicious/noExplicitAny: `any` is the default so an unspecified Database generic stays compatible with the upstream PostgrestClient's untyped schema.
export function createClient<Database = any>(
	config: CreateClientExternalConfig<DefaultSchemaName<Database>>,
): NeonPostgrestClient<Database, DefaultSchemaName<Database>>;

// Overload: No adapter specified (defaults to BetterAuthVanillaAdapter)
// biome-ignore lint/suspicious/noExplicitAny: `any` is the default so an unspecified Database generic stays compatible with the upstream PostgrestClient's untyped schema.
export function createClient<Database = any>(config: {
	auth: { url: string; allowAnonymous?: boolean };
	dataApi: CreateClientDataApiConfig<
		DefaultSchemaName<Database>,
		BetterAuthVanillaAdapterInstance
	>;
}): CreateClientResult<Database, BetterAuthVanillaAdapterInstance>;

// Overload: SupabaseAuthAdapter
// biome-ignore lint/suspicious/noExplicitAny: `any` is the default so an unspecified Database generic stays compatible with the upstream PostgrestClient's untyped schema.
export function createClient<Database = any>(
	config: CreateClientConfig<
		DefaultSchemaName<Database>,
		SupabaseAuthAdapterInstance
	>,
): CreateClientResult<Database, SupabaseAuthAdapterInstance>;

// Overload: BetterAuthVanillaAdapter
// biome-ignore lint/suspicious/noExplicitAny: `any` is the default so an unspecified Database generic stays compatible with the upstream PostgrestClient's untyped schema.
export function createClient<Database = any>(
	config: CreateClientConfig<
		DefaultSchemaName<Database>,
		BetterAuthVanillaAdapterInstance
	>,
): CreateClientResult<Database, BetterAuthVanillaAdapterInstance>;

// Overload: BetterAuthReactAdapter
// biome-ignore lint/suspicious/noExplicitAny: `any` is the default so an unspecified Database generic stays compatible with the upstream PostgrestClient's untyped schema.
export function createClient<Database = any>(
	config: CreateClientConfig<
		DefaultSchemaName<Database>,
		BetterAuthReactAdapterInstance
	>,
): CreateClientResult<Database, BetterAuthReactAdapterInstance>;

// Overload: String form, no adapter specified (defaults to BetterAuthVanillaAdapter)
// biome-ignore lint/suspicious/noExplicitAny: `any` is the default so an unspecified Database generic stays compatible with the upstream PostgrestClient's untyped schema.
export function createClient<Database = any>(
	baseUrl: string,
	options?: CreateClientStringOptions<
		DefaultSchemaName<Database>,
		BetterAuthVanillaAdapterInstance
	>,
): CreateClientResult<Database, BetterAuthVanillaAdapterInstance>;

// Overload: String form, SupabaseAuthAdapter
// biome-ignore lint/suspicious/noExplicitAny: `any` is the default so an unspecified Database generic stays compatible with the upstream PostgrestClient's untyped schema.
export function createClient<Database = any>(
	baseUrl: string,
	options: CreateClientStringOptions<
		DefaultSchemaName<Database>,
		SupabaseAuthAdapterInstance
	> & { auth: { adapter: AdapterBuilder<SupabaseAuthAdapterInstance> } },
): CreateClientResult<Database, SupabaseAuthAdapterInstance>;

// Overload: String form, BetterAuthVanillaAdapter
// biome-ignore lint/suspicious/noExplicitAny: `any` is the default so an unspecified Database generic stays compatible with the upstream PostgrestClient's untyped schema.
export function createClient<Database = any>(
	baseUrl: string,
	options: CreateClientStringOptions<
		DefaultSchemaName<Database>,
		BetterAuthVanillaAdapterInstance
	> & { auth: { adapter: AdapterBuilder<BetterAuthVanillaAdapterInstance> } },
): CreateClientResult<Database, BetterAuthVanillaAdapterInstance>;

// Overload: String form, BetterAuthReactAdapter
// biome-ignore lint/suspicious/noExplicitAny: `any` is the default so an unspecified Database generic stays compatible with the upstream PostgrestClient's untyped schema.
export function createClient<Database = any>(
	baseUrl: string,
	options: CreateClientStringOptions<
		DefaultSchemaName<Database>,
		BetterAuthReactAdapterInstance
	> & { auth: { adapter: AdapterBuilder<BetterAuthReactAdapterInstance> } },
): CreateClientResult<Database, BetterAuthReactAdapterInstance>;

// Implementation signature
export function createClient<
	// biome-ignore lint/suspicious/noExplicitAny: `any` is the default so an unspecified Database generic stays compatible with the upstream PostgrestClient's untyped schema.
	Database = any,
	SchemaName extends string & keyof Database = DefaultSchemaName<Database>,
	TAuthAdapter extends NeonAuthAdapter = BetterAuthVanillaAdapterInstance,
>(
	arg1:
		| string
		| CreateClientConfig<SchemaName, TAuthAdapter>
		| CreateClientExternalConfig<SchemaName>,
	arg2?: CreateClientStringOptions<SchemaName, TAuthAdapter>,
):
	| NeonClient<Database, SchemaName, TAuthAdapter>
	| NeonPostgrestClient<Database, SchemaName> {
	// External-auth-provider form: no `auth` block, a `getToken` on `dataApi`.
	// Build a plain NeonPostgrestClient and let the caller's token flow through
	// unchanged — no Neon Auth client is created.
	if (typeof arg1 !== "string" && !arg1.auth) {
		return buildExternalClient<Database, SchemaName>(
			(arg1 as CreateClientExternalConfig<SchemaName>).dataApi,
		);
	}

	const config: CreateClientConfig<SchemaName, TAuthAdapter> =
		typeof arg1 === "string"
			? buildConfigFromBaseUrl<SchemaName, TAuthAdapter>(arg1, arg2)
			: (arg1 as CreateClientConfig<SchemaName, TAuthAdapter>);

	const { auth: authConfig, dataApi: dataApiConfig } = config;

	// Build client info once - sub-packages will see it and skip their own injection
	const clientInfoHeader = buildNeonJsClientInfo();

	// Step 1: Instantiate auth adapter
	const auth = createInternalNeonAuth<TAuthAdapter>(authConfig.url, {
		adapter: authConfig.adapter,
		allowAnonymous: authConfig.allowAnonymous ?? false,
		fetchOptions: {
			headers: {
				[X_NEON_CLIENT_INFO_HEADER]: clientInfoHeader,
			},
		},
	});

	// Step 2: Create lazy token accessor - called on every request
	// Returns null if no session (will throw AuthRequiredError in fetchWithToken)
	const getAccessToken = async (): Promise<string | null> => {
		return auth.getJWTToken();
	};

	// Step 3: Create auth-aware fetch wrapper
	const authFetch = fetchWithToken(
		getAccessToken,
		dataApiConfig.options?.global?.fetch,
	);

	// Step 4: Create client with auth integrated
	const client = new NeonClient<Database, SchemaName, TAuthAdapter>({
		dataApiUrl: dataApiConfig.url,
		authClient: auth,
		options: {
			...dataApiConfig.options,
			global: {
				...dataApiConfig.options?.global,
				fetch: authFetch,
				headers: {
					...dataApiConfig.options?.global?.headers,
					[X_NEON_CLIENT_INFO_HEADER]: clientInfoHeader,
				},
			},
		},
	});

	return client;
}

/**
 * Builds the external-auth-provider client: a plain NeonPostgrestClient whose
 * every request carries the caller's token via `fetchWithToken(getToken)`.
 *
 * Mirrors the fetch/header wiring of the auth path, but the token comes from
 * the caller's `getToken` rather than a Neon Auth session.
 */
function buildExternalClient<
	Database,
	SchemaName extends string & keyof Database,
>(
	dataApiConfig: CreateClientExternalDataApiConfig<SchemaName>,
): NeonPostgrestClient<Database, SchemaName> {
	const clientInfoHeader = buildNeonJsClientInfo();

	const tokenFetch = fetchWithToken(
		dataApiConfig.getToken,
		dataApiConfig.options?.global?.fetch,
	);

	const options: NeonPostgrestClientConstructorOptions<SchemaName>["options"] =
		{
			...dataApiConfig.options,
			global: {
				...dataApiConfig.options?.global,
				fetch: tokenFetch,
				headers: {
					...dataApiConfig.options?.global?.headers,
					[X_NEON_CLIENT_INFO_HEADER]: clientInfoHeader,
				},
			},
		};

	return new NeonPostgrestClient<Database, SchemaName>({
		dataApiUrl: dataApiConfig.url,
		options,
	});
}

/**
 * Per-call overrides accepted alongside a single base URL.
 *
 * Every field is optional; defaults come from `deriveUrls(baseUrl)`.
 */
export type CreateClientStringOptions<SchemaName, T extends NeonAuthAdapter> = {
	auth?: Partial<CreateClientAuthConfig<T>>;
	dataApi?: Partial<CreateClientDataApiConfig<SchemaName, T>>;
	/**
	 * Override the auth/Data API URL derivation. End users do not need this;
	 * it is intended for wrapper packages (e.g. `@databricks/lakebase-js`)
	 * that have their own endpoint pattern.
	 */
	deriveUrls?: DeriveNeonUrls;
};

function buildConfigFromBaseUrl<
	SchemaName,
	TAuthAdapter extends NeonAuthAdapter,
>(
	baseUrl: string,
	options: CreateClientStringOptions<SchemaName, TAuthAdapter> | undefined,
): CreateClientConfig<SchemaName, TAuthAdapter> {
	const derive = options?.deriveUrls ?? defaultDeriveNeonUrls;
	const derived = derive(baseUrl);

	const authOverrides = options?.auth ?? {};
	const dataApiOverrides = options?.dataApi ?? {};

	return {
		auth: {
			...authOverrides,
			url: authOverrides.url ?? derived.auth,
		} as CreateClientAuthConfig<TAuthAdapter>,
		dataApi: {
			...dataApiOverrides,
			url: dataApiOverrides.url ?? derived.dataApi,
		} as CreateClientDataApiConfig<SchemaName, TAuthAdapter>,
	};
}
