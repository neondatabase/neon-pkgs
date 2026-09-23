import { createAuthServer } from "@/server";
import type { NeonAuthConfig, NeonAuthMiddlewareConfig } from "@/server/config";
import { validateCookieConfig } from "@/server/config";
import { resolveNeonAuthLogging } from "@/server/logger";
import type { NeonAuthServer } from "@/server/types";
import { createNextRequestContext } from "./adapter";
import { authApiHandler } from "./handler";
import { neonAuthMiddleware } from "./middleware";

// Re-export auth error classes + type guards for server-side consumers
// importing from `@neon/auth/next/server`. The error field returned
// from server methods is a POJO, but thrown errors from adapter internals
// still benefit from `instanceof` narrowing.
export {
	AuthApiError,
	AuthError,
	isAuthApiError,
	isAuthError,
} from "@/adapters/supabase/auth-interface";

export {
	type NeonAuthLogger,
	type NeonAuthLoggingInput,
	type NeonAuthLogLevel,
	type ResolvedNeonAuthLogging,
	resolveNeonAuthLogging,
} from "@/server/logger";
export {
	type ClassifiedFetchFailure,
	classifyFetchFailure,
	NEON_AUTH_NETWORK_ERROR_CODES,
	type NeonAuthNetworkErrorCode,
} from "@/server/network-error";
export type { NeonAuthServerApiError } from "@/server/types";

/**
 * Unified entry point for Neon Auth in Next.js
 *
 * This is the recommended way to use Neon Auth in Next.js. It provides a single
 * entry point that combines all server-side functionality.
 *
 * **Features:**
 * - All Better Auth server methods (signIn, signUp, getSession, etc.)
 * - `.handler()` - API route handler for `/api/auth/[...path]`
 * - `.middleware(config?)` - Middleware for route protection
 *
 * **Where to use:**
 * - React Server Components
 * - Server Actions
 * - Route Handlers
 * - Middleware
 *
 * @param config - Required configuration
 * @param config.baseUrl - Base URL of your Neon Auth instance
 * @param config.cookies - Cookie configuration
 * @param config.cookies.secret - Secret for signing session cookies (minimum 32 characters)
 * @param config.cookies.sessionDataTtl - Optional TTL for session cache in seconds (default: 300)
 * @param config.cookies.domain - Optional cookie domain (default: current domain)
 * @param config.logger - Optional structured logger; omitted methods fall back to `console` (see {@link NeonAuthLogger})
 * @param config.logLevel - Minimum level; `'silent'` disables Neon Auth server console logs (default: `warn`)
 * @returns Unified auth instance with server methods, handler, and middleware
 * @throws Error if `cookies.secret` is less than 32 characters
 *
 * @example
 * ```typescript
 * // lib/auth.ts - Create a singleton instance
 * import { createNeonAuth } from '@neon/auth/next/server';
 *
 * export const auth = createNeonAuth({
 *   baseUrl: process.env.NEON_AUTH_BASE_URL!,
 *   cookies: {
 *     secret: process.env.NEON_AUTH_COOKIE_SECRET!,
 *     sessionDataTtl: 300, // 5 minutes (default)
 *   },
 * });
 * ```
 *
 * @example
 * ```typescript
 * // app/api/auth/[...path]/route.ts - API handler
 * import { auth } from '@/lib/auth';
 *
 * export const { GET, POST } = auth.handler();
 * ```
 *
 * @example
 * ```typescript
 * // middleware.ts - Route protection
 * import { auth } from '@/lib/auth';
 *
 * export default auth.middleware({ loginUrl: '/auth/sign-in' });
 *
 * export const config = {
 *   matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
 * };
 * ```
 *
 * @example
 * ```typescript
 * // app/page.tsx - Server Component
 * import { auth } from '@/lib/auth';
 *
 * // Server components using `auth` methods must be rendered dynamically
 * export const dynamic = 'force-dynamic'
 *
 * export default async function Page() {
 *   const { data: session } = await auth.getSession();
 *   if (!session?.user) return <div>Not logged in</div>;
 *   return <div>Hello {session.user.name}</div>;
 * }
 * ```
 *
 * @example
 * ```typescript
 * // app/actions.ts - Server Action
 * 'use server';
 * import { auth } from '@/lib/auth';
 * import { redirect } from 'next/navigation';
 *
 * export async function signIn(formData: FormData) {
 *   const { error } = await auth.signIn.email({
 *     email: formData.get('email') as string,
 *     password: formData.get('password') as string,
 *   });
 *   if (error) return { error: error.message };
 *   redirect('/dashboard');
 * }
 * ```
 */
export function createNeonAuth(config: NeonAuthConfig) {
	const { baseUrl, cookies } = config;

	validateCookieConfig(cookies);

	const log = resolveNeonAuthLogging(config);

	// Create base server with all Better Auth methods
	const server = createAuthServer({
		baseUrl,
		context: createNextRequestContext,
		cookieSecret: cookies.secret,
		sessionDataTtl: cookies.sessionDataTtl,
		domain: cookies.domain,
		sameSite: cookies.sameSite,
		log,
	});

	// Attach handler and middleware directly to the server proxy object
	// instead of spreading (spreading a Proxy doesn't copy dynamic properties)
	/**
	 * Creates API route handlers for Next.js
	 *
	 * Mount this in your API routes to handle auth requests:
	 * - `/api/auth/[...path]/route.ts`
	 *
	 * @returns Object with GET, POST, PUT, DELETE, PATCH handlers
	 *
	 * @example
	 * ```typescript
	 * // app/api/auth/[...path]/route.ts
	 * import { auth } from '@/lib/auth';
	 *
	 * export const { GET, POST } = auth.handler();
	 * ```
	 */
	(server as NeonAuth).handler = () => authApiHandler(config);

	/**
	 * Creates middleware for route protection
	 *
	 * Protects routes from unauthenticated access and handles:
	 * - Session validation and refresh
	 * - OAuth callback processing
	 * - Login redirects
	 *
	 * @param middlewareConfig - Optional middleware configuration
	 * @param middlewareConfig.loginUrl - URL to redirect to when not authenticated (default: '/auth/sign-in')
	 * @returns Middleware function for Next.js
	 *
	 * @example
	 * ```typescript
	 * // middleware.ts
	 * import { auth } from '@/lib/auth';
	 *
	 * export default auth.middleware({ loginUrl: '/auth/sign-in' });
	 *
	 * export const config = {
	 *   matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
	 * };
	 * ```
	 */
	(server as NeonAuth).middleware = (
		middlewareConfig?: Pick<NeonAuthMiddlewareConfig, "loginUrl">,
	) => neonAuthMiddleware({ ...config, ...middlewareConfig, log });

	return server as NeonAuth;
}

/**
 * Return type for createNeonAuth
 * Includes all Better Auth server methods plus handler() and middleware()
 */
export type NeonAuth = NeonAuthServer & {
	handler: () => ReturnType<typeof authApiHandler>;
	middleware: (
		middlewareConfig?: Pick<NeonAuthMiddlewareConfig, "loginUrl">,
	) => ReturnType<typeof neonAuthMiddleware>;
};
