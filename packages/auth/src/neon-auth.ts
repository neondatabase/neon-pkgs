import type { BetterAuthReactAdapterInstance } from "./adapters/better-auth-react/better-auth-react-adapter";
import {
	BetterAuthVanillaAdapter,
	type BetterAuthVanillaAdapterInstance,
} from "./adapters/better-auth-vanilla/better-auth-vanilla-adapter";
import type { SupabaseAuthAdapterInstance } from "./adapters/supabase/supabase-adapter";
import type { ReactBetterAuthClient, VanillaBetterAuthClient } from "./types";

/**
 * Union type of all supported auth adapter instances
 */
export type NeonAuthAdapter =
	| BetterAuthVanillaAdapterInstance
	| BetterAuthReactAdapterInstance
	| SupabaseAuthAdapterInstance;

/**
 * Configuration for createAuthClient
 */
export interface NeonAuthConfig<T extends NeonAuthAdapter> {
	/** The adapter builder to use. Defaults to BetterAuthVanillaAdapter() if not specified. */
	adapter?: (
		url: string,
		fetchOptions?: { headers?: Record<string, string> },
	) => T;
	/**
	 * When true, automatically uses an anonymous token when no user session exists.
	 * This enables RLS-based data access for users with the anonymous role.
	 * @default false
	 */
	allowAnonymous?: boolean;
}

/**
 * Extended configuration for createInternalNeonAuth.
 * Includes fetchOptions for SDK identification headers.
 * @internal - Used by neon-js for header injection
 */
interface NeonAuthConfigInternal<T extends NeonAuthAdapter>
	extends NeonAuthConfig<T> {
	/**
	 * Additional fetch options to pass to the auth adapter.
	 * Used by neon-js to inject SDK identification headers.
	 * @internal
	 */
	fetchOptions?: {
		headers?: Record<string, string>;
	};
}

/**
 * Resolves the public API type for an adapter.
 * - SupabaseAuthAdapter: exposes its own methods directly (Supabase-compatible API)
 * - BetterAuth adapters: expose the Better Auth client directly
 */
export type NeonAuthPublicApi<T extends NeonAuthAdapter> =
	T extends BetterAuthVanillaAdapterInstance
		? VanillaBetterAuthClient
		: T extends BetterAuthReactAdapterInstance
			? ReactBetterAuthClient
			: T; // SupabaseAuthAdapter - use adapter methods directly

/**
 * NeonAuth type - combines base functionality with the appropriate public API
 * This is the return type of createAuthClient()
 *
 * For SupabaseAuthAdapter: exposes Supabase-compatible methods (signInWithPassword, getSession, etc.)
 * For BetterAuth adapters: exposes the Better Auth client directly (signIn.email, signUp.email, etc.)
 */
export type NeonAuth<T extends NeonAuthAdapter> = {
	adapter: NeonAuthPublicApi<T>;
	getJWTToken: () => Promise<string | null>;
};

/**
 * Create a NeonAuth instance that exposes the appropriate API based on the adapter.
 *
 * @param url - The auth service URL (e.g., 'https://auth.example.com')
 * @param config - Configuration with adapter builder
 * @returns NeonAuth instance with the adapter's API exposed directly
 *
 * @example SupabaseAuthAdapter - Supabase-compatible API
 * ```typescript
 * import { createAuthClient, SupabaseAuthAdapter } from '@neon/auth';
 *
 * const auth = createAuthClient('https://auth.example.com', {
 *   adapter: SupabaseAuthAdapter(),
 * });
 *
 * // Supabase-compatible methods
 * await auth.signInWithPassword({ email, password });
 * await auth.getSession();
 * ```
 *
 * @example BetterAuthVanillaAdapter - Direct Better Auth API
 * ```typescript
 * import { createAuthClient, BetterAuthVanillaAdapter } from '@neon/auth';
 *
 * const auth = createAuthClient('https://auth.example.com', {
 *   adapter: BetterAuthVanillaAdapter(),
 * });
 *
 * // Direct Better Auth API access
 * await auth.signIn.email({ email, password });
 * await auth.signUp.email({ email, password, name: 'John' });
 * await auth.getSession();
 * ```
 *
 * @example BetterAuthReactAdapter - Better Auth with React hooks
 * ```typescript
 * import { createAuthClient, BetterAuthReactAdapter } from '@neon/auth';
 *
 * const auth = createAuthClient('https://auth.example.com', {
 *   adapter: BetterAuthReactAdapter(),
 * });
 *
 * // Direct Better Auth API with React hooks
 * await auth.signIn.email({ email, password });
 * const session = auth.useSession(); // React hook
 * ```
 */
export function createInternalNeonAuth<
	T extends NeonAuthAdapter = BetterAuthVanillaAdapterInstance,
>(url: string, config?: NeonAuthConfigInternal<T>): NeonAuth<T> {
	// Default to BetterAuthVanillaAdapter if no adapter specified
	const adapterBuilder = config?.adapter ?? BetterAuthVanillaAdapter();
	const { fetchOptions } = config ?? {};
	const adapter = adapterBuilder(url, fetchOptions) as T;

	// Capture allowAnonymous at creation time
	const allowAnonymous = config?.allowAnonymous ?? false;

	// Check if this is a SupabaseAuthAdapter by checking for its unique initialize method
	const isSupabaseAuthAdapter =
		typeof (adapter as { initialize?: unknown }).initialize === "function";

	if (!isSupabaseAuthAdapter) {
		return {
			getJWTToken: () => adapter.getJWTToken(allowAnonymous),
			adapter: adapter.getBetterAuthInstance(),
		} as NeonAuth<T>;
	}

	return {
		getJWTToken: () => adapter.getJWTToken(allowAnonymous),
		adapter,
	} as NeonAuth<T>;
}

export function createAuthClient<
	T extends NeonAuthAdapter = BetterAuthVanillaAdapterInstance,
>(url: string, config?: NeonAuthConfig<T>): NeonAuthPublicApi<T> {
	const internalAuth = createInternalNeonAuth(url, config);
	return internalAuth.adapter;
}
