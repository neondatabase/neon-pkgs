import type { AuthClient as UpstreamAuthClient } from "@supabase/auth-js";

type _UpstreamAuthClientInstance = InstanceType<typeof UpstreamAuthClient>;
type _AuthClientBase = {
	[K in keyof _UpstreamAuthClientInstance as _UpstreamAuthClientInstance[K] extends never
		? never
		: K]: _UpstreamAuthClientInstance[K]; // This filters out protected/private members by checking if they are accessible
};

export type SupabaseAuthClientInterface = _AuthClientBase;

// Re-export error types for auth handling
export {
	AuthApiError,
	AuthError,
	isAuthApiError,
	isAuthError,
} from "@supabase/auth-js";
