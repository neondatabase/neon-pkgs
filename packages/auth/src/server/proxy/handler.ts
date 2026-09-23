import type { SessionCookieSameSite } from "../config";
import { API_ENDPOINTS } from "../endpoints";
import type { NeonAuthLogger, ResolvedNeonAuthLogging } from "../logger";
import { resolveLog } from "../logger";
import { trySessionCache } from "../session/cache-handler";
import { handleAuthRequest } from "./request";
import { handleAuthResponse } from "./response";

export interface AuthProxyConfig {
	/** Standard Web API Request object */
	request: Request;
	/** API path to proxy (e.g., 'get-session', 'sign-in') */
	path: string;
	/** Base URL of Neon Auth server */
	baseUrl: string;
	/** Secret for signing session cookies */
	cookieSecret: string;
	/** Time-to-live for session data cache in seconds (default: 300 = 5 minutes) */
	sessionDataTtl?: number;
	/** Cookie domain for session data cookie */
	domain?: string;
	/** SameSite for proxied and minted cookies (default: lax) */
	sameSite?: SessionCookieSameSite;
	/**
	 * Logging sink. Accepts either a pre-resolved sink (from
	 * {@link resolveNeonAuthLogging}) or a partial {@link NeonAuthLogger} (e.g.
	 * forwarded from your adapter's public `log` config). A partial logger is
	 * normalized internally at the default `'warn'` level. Omit for downstream
	 * silence.
	 */
	log?: ResolvedNeonAuthLogging | NeonAuthLogger;
}

/**
 * Generic authentication proxy handler (framework-agnostic)
 *
 * Handles the complete flow:
 * 1. Check if request is for getSession endpoint
 * 2. Try session cache if applicable (< 1ms fast path)
 * 3. Call upstream Neon Auth API
 * 4. Handle response with cookie minting
 *
 * This is framework-agnostic and can be used by any server framework.
 *
 * @param config - Proxy configuration
 * @returns Standard Web API Response
 */
export async function handleAuthProxyRequest(
	config: AuthProxyConfig,
): Promise<Response> {
	const {
		request,
		path,
		baseUrl,
		cookieSecret,
		sessionDataTtl,
		domain,
		sameSite,
	} = config;
	// Normalize the optional logger once. Pre-resolved sinks pass through
	// unchanged (preserves caller-side level gating); partial loggers (e.g.
	// `{ warn, error }` forwarded from an adapter's public config) are merged
	// with `console` defaults at the default `'warn'` level. `undefined` stays
	// `undefined` so downstream `?.warn(...)` calls remain silent.
	const log = resolveLog(config.log);

	// Try cookie cache for /get-session GET requests (optimization)
	if (
		path === API_ENDPOINTS.getSession.path &&
		request.method === API_ENDPOINTS.getSession.method
	) {
		const cachedResponse = await trySessionCache(
			request,
			baseUrl,
			{
				secret: cookieSecret,
				sessionDataTtl,
				domain,
				sameSite,
			},
			log,
		);
		if (cachedResponse) {
			// Cache hit - return immediately (no upstream call)
			return cachedResponse;
		}
	}

	// Fallback: Call upstream API
	const response = await handleAuthRequest(baseUrl, request, path, log);
	return await handleAuthResponse(
		response,
		baseUrl,
		{
			secret: cookieSecret,
			sessionDataTtl,
			domain,
			sameSite,
		},
		log,
	);
}
