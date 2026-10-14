// Main client factory

// Re-export auth utilities (no React dependency)
export type {
	NeonAuth,
	NeonAuthAdapter,
	NeonAuthConfig,
	NeonAuthPublicApi,
	ReactBetterAuthClient,
	VanillaBetterAuthClient,
} from "@neon/auth";
// Re-export vanilla adapters (no React dependency)
export {
	BetterAuthVanillaAdapter,
	type BetterAuthVanillaAdapterInstance,
	type BetterAuthVanillaAdapterOptions,
	SupabaseAuthAdapter,
	type SupabaseAuthAdapterInstance,
	type SupabaseAuthAdapterOptions,
} from "@neon/auth/vanilla/adapters";
// Re-export utilities from postgrest-js for convenience
// The external-auth-provider form of createClient returns this type
export {
	AuthRequiredError,
	fetchWithToken,
	NeonPostgrestClient,
} from "@neon/postgrest-js";
export type {
	CreateClientExternalConfig,
	CreateClientExternalDataApiConfig,
	CreateClientStringOptions,
	NeonDataApiTokenProvider,
} from "./client/client-factory";
export { createClient } from "./client/client-factory";
// URL derivation (mostly used by wrappers; end users don't need this)
export {
	type DeriveNeonUrls,
	defaultDeriveNeonUrls,
} from "./client/derive-urls";
