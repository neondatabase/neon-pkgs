import type { NeonAuthConfig } from "@/server/config";
import { validateCookieConfig } from "@/server/config";
import { resolveNeonAuthLogging } from "@/server/logger";
import { handleAuthProxyRequest } from "@/server/proxy";

type Params = { path: string[] };

/**
 * An API route handler to handle the auth requests from the client and proxy them to the Neon Auth.
 *
 * @param config - Required configuration
 * @param config.baseUrl - Base URL of your Neon Auth instance
 * @param config.cookies - Cookie configuration
 * @param config.cookies.secret - Secret for signing session cookies (minimum 32 characters)
 * @param config.cookies.sessionDataTtl - Optional TTL for session cache in seconds (default: 300)
 * @returns A Next.js API handler functions that can be used in a Next.js route.
 * @throws Error if `cookies.secret` is less than 32 characters
 *
 * @example
 * Mount the `authApiHandler` to an API route. Create a route file inside `/api/auth/[...all]/route.ts` directory.
 * And add the following code:
 *
 * ```ts
 * // app/api/auth/[...all]/route.ts
 * import { authApiHandler } from '@neon/auth/next';
 *
 * export const { GET, POST } = authApiHandler({
 *   baseUrl: process.env.NEON_AUTH_BASE_URL!,
 *   cookies: {
 *     secret: process.env.NEON_AUTH_COOKIE_SECRET!,
 *   },
 * });
 * ```
 */
export function authApiHandler(config: NeonAuthConfig) {
	const { baseUrl, cookies } = config;

	validateCookieConfig(cookies);
	const log = resolveNeonAuthLogging(config);
	const handler = async (
		request: Request,
		{ params }: { params: Promise<Params> },
	) => {
		const resolvedParams = await params;
		const path = resolvedParams.path.join("/");

		return handleAuthProxyRequest({
			request,
			path,
			baseUrl,
			cookieSecret: cookies.secret,
			sessionDataTtl: cookies.sessionDataTtl,
			domain: cookies.domain,
			sameSite: cookies.sameSite,
			log,
		});
	};

	return {
		GET: handler,
		POST: handler,
		PUT: handler,
		DELETE: handler,
		PATCH: handler,
	};
}
