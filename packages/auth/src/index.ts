// NeonAuth factory and types

// Auth error classes + type guards. Documented in llms.txt as the public
// surface for `instanceof AuthApiError` / `instanceof AuthError` narrowing.
export {
	AuthApiError,
	AuthError,
	isAuthApiError,
	isAuthError,
} from "./adapters/supabase/auth-interface";
export type {
	NeonAuth,
	NeonAuthAdapter,
	NeonAuthConfig,
	NeonAuthPublicApi,
} from "./neon-auth";
export { createAuthClient, createInternalNeonAuth } from "./neon-auth";
export type { ReactBetterAuthClient, VanillaBetterAuthClient } from "./types";
