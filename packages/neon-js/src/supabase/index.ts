import {
	SupabaseAuthAdapter,
	type SupabaseAuthAdapterInstance,
	type SupabaseAuthAdapterOptions,
} from "@neon/auth/vanilla/adapters";
import {
	type CreateClientDataApiConfig,
	type CreateClientResult,
	createClientImpl,
} from "../client/client-factory";
import type { DeriveNeonUrls } from "../client/derive-urls";
import type { DefaultSchemaName, NeonClient } from "../client/neon-client";

/**
 * `url` and `allowAnonymous` configure the client; every other key is forwarded to
 * `SupabaseAuthAdapter(...)`, e.g. `fetchOptions.headers.Cookie` to forward a request
 * cookie from a server.
 */
type SupabaseAuthConfig = SupabaseAuthAdapterOptions & {
	/** The auth service URL */
	url: string;
	/** Fall back to an anonymous token when there is no user session. */
	allowAnonymous?: boolean;
};

type SupabaseDataApiConfig<SchemaName> = CreateClientDataApiConfig<
	SchemaName,
	SupabaseAuthAdapterInstance
>;

/** Configuration for the Supabase-compatible `createClient`. */
export type CreateSupabaseClientConfig<SchemaName> = {
	auth: SupabaseAuthConfig;
	dataApi: SupabaseDataApiConfig<SchemaName>;
};

/** Per-call overrides accepted alongside a single base URL. */
export type CreateSupabaseClientStringOptions<SchemaName> = {
	auth?: Partial<SupabaseAuthConfig>;
	dataApi?: Partial<SupabaseDataApiConfig<SchemaName>>;
	deriveUrls?: DeriveNeonUrls;
};

/**
 * `createClient` with the auth adapter fixed to `SupabaseAuthAdapter`, so `client.auth`
 * has the Supabase-compatible API (`signInWithPassword`, `onAuthStateChange`, ...).
 *
 * @example
 * ```typescript
 * import { createClient } from '@neon/neon-js/supabase';
 *
 * const client = createClient({
 *   auth: { url: 'https://auth.example.com' },
 *   dataApi: { url: 'https://data-api.example.com/rest/v1' },
 * });
 *
 * await client.auth.signInWithPassword({ email, password });
 * const { data: items } = await client.from('items').select();
 * ```
 */
// biome-ignore lint/suspicious/noExplicitAny: `any` is the default so an unspecified Database generic stays compatible with the upstream PostgrestClient's untyped schema.
export function createClient<Database = any>(
	config: CreateSupabaseClientConfig<DefaultSchemaName<Database>>,
): CreateClientResult<Database, SupabaseAuthAdapterInstance>;
// biome-ignore lint/suspicious/noExplicitAny: `any` is the default so an unspecified Database generic stays compatible with the upstream PostgrestClient's untyped schema.
export function createClient<Database = any>(
	baseUrl: string,
	options?: CreateSupabaseClientStringOptions<DefaultSchemaName<Database>>,
): CreateClientResult<Database, SupabaseAuthAdapterInstance>;
export function createClient<
	// biome-ignore lint/suspicious/noExplicitAny: `any` is the default so an unspecified Database generic stays compatible with the upstream PostgrestClient's untyped schema.
	Database = any,
	SchemaName extends string & keyof Database = DefaultSchemaName<Database>,
>(
	arg1: string | CreateSupabaseClientConfig<SchemaName>,
	arg2?: CreateSupabaseClientStringOptions<SchemaName>,
): NeonClient<Database, SchemaName, SupabaseAuthAdapterInstance> {
	// An `auth` block is always present here, so the implementation never takes its
	// external-auth branch and the result always carries `.auth`.
	const client =
		typeof arg1 === "string"
			? createClientImpl<
					Database,
					SchemaName,
					SupabaseAuthAdapterInstance
				>(arg1, { ...arg2, auth: withAdapter(arg2?.auth) })
			: createClientImpl<
					Database,
					SchemaName,
					SupabaseAuthAdapterInstance
				>({
					...arg1,
					auth: withAdapter(arg1.auth),
				});
	return client as NeonClient<
		Database,
		SchemaName,
		SupabaseAuthAdapterInstance
	>;
}

function withAdapter<T extends Partial<SupabaseAuthConfig>>(
	auth: T | undefined,
) {
	const { url, allowAnonymous, ...adapterOptions } = auth ?? {};
	return {
		url,
		allowAnonymous,
		adapter: SupabaseAuthAdapter(adapterOptions),
	} as Omit<T, keyof SupabaseAuthAdapterOptions> & {
		adapter: ReturnType<typeof SupabaseAuthAdapter>;
	};
}
