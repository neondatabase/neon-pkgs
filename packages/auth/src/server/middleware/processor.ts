import { parseCookies } from "better-auth/cookies";
import type { SessionCookieSameSite } from "../config";
import {
	NEON_AUTH_SESSION_COOKIE_NAME,
	NEON_AUTH_SESSION_DATA_COOKIE_NAME,
} from "../constants";
import type { NeonAuthLoggingInput, ResolvedNeonAuthLogging } from "../logger";
import { resolveNeonAuthLogging } from "../logger";
import {
	handleAuthProxyRequest,
	NEON_AUTH_HEADER_MIDDLEWARE_NAME,
} from "../proxy";
import type { SessionData } from "../types";
import { serializeSetCookie } from "../utils/cookies";
import { exchangeOAuthToken, needsSessionVerification } from "./oauth";
import { checkSessionRequired, isSamePathOrSubpath } from "./route-protection";

/**
 * Result of middleware processing (framework-agnostic decision)
 */
export type MiddlewareResult =
	| { action: "allow"; headers?: Record<string, string>; cookies?: string[] }
	| { action: "redirect_oauth"; redirectUrl: URL; cookies: string[] }
	| { action: "redirect_login"; redirectUrl: URL; cookies?: string[] };

export type AuthMiddlewareConfig = {
	/** Standard Web API Request object */
	request: Request;
	/** URL pathname being accessed */
	pathname: string;
	/** Routes that don't require authentication */
	skipRoutes: readonly string[];
	/** URL to redirect to for login */
	loginUrl: string;
	/** Base URL of Neon Auth server */
	baseUrl: string;
	/** Secret for signing session cookies */
	cookieSecret: string;
	/** Time-to-live for session data cache in seconds */
	sessionDataTtl?: number;
	/** Cookie domain for session data cookie */
	domain?: string;
	/** SameSite for cookies set by middleware (default: lax) */
	sameSite?: SessionCookieSameSite;
	/** Pre-resolved sink; preferred over resolving from logger/logLevel */
	log?: ResolvedNeonAuthLogging;
} & NeonAuthLoggingInput;

/**
 * Returns a copy of `headers` without body-framing headers
 * (`Content-Type` / `Content-Length` / `Transfer-Encoding`).
 *
 * The session lookup re-issues the request as a body-less GET, so these
 * leftover headers would misdescribe it and could trip stricter upstreams.
 */
function stripBodyHeaders(headers: Headers): Headers {
	const next = new Headers(headers);
	next.delete("content-type");
	next.delete("content-length");
	next.delete("transfer-encoding");
	return next;
}

/**
 * Generic authentication middleware processor (framework-agnostic)
 *
 * Handles the complete middleware flow:
 * 1. Check if login URL (skip auth)
 * 2. Check OAuth verification (exchange token)
 * 3. Get session (delegates to handleAuthProxyRequest for cookie cache + upstream fallback)
 * 4. Check if route requires protection
 * 5. Return decision object
 *
 * This is framework-agnostic - it returns a decision, NOT a framework-specific response.
 * The calling framework converts the decision to its response type (NextResponse, etc.)
 *
 * @param config - Middleware configuration
 * @returns Decision object indicating what action to take
 */
export async function processAuthMiddleware(
	config: AuthMiddlewareConfig,
): Promise<MiddlewareResult> {
	const log =
		config.log ??
		resolveNeonAuthLogging({
			logger: config.logger,
			logLevel: config.logLevel,
		});

	const {
		request,
		pathname,
		skipRoutes,
		loginUrl,
		baseUrl,
		cookieSecret,
		sessionDataTtl,
		domain,
		sameSite,
	} = config;

	const effectiveSameSite = sameSite ?? "lax";
	const requestUrl = new URL(request.url);
	const resolvedLoginUrl = new URL(loginUrl, requestUrl);
	const sameOriginLoginPathname =
		resolvedLoginUrl.origin === requestUrl.origin
			? resolvedLoginUrl.pathname
			: null;

	// Always skip session check for login URL to prevent infinite redirect loop
	if (
		sameOriginLoginPathname !== null &&
		isSamePathOrSubpath(pathname, sameOriginLoginPathname)
	) {
		return { action: "allow" };
	}

	// For OAuth flow, the callback from Neon Auth will include a session verifier token in the query params
	// We need to exchange the verifier token and session challenge for the session cookie
	const verification = needsSessionVerification(request);
	if (verification) {
		const exchangeResult = await exchangeOAuthToken(
			request,
			baseUrl,
			cookieSecret,
			sessionDataTtl,
			domain,
			sameSite,
			log,
		);
		if (exchangeResult !== null) {
			// OAuth exchange successful - redirect with session cookies
			return {
				action: "redirect_oauth",
				redirectUrl: exchangeResult.redirectUrl,
				cookies: exchangeResult.cookies,
			};
		}
	}

	// Check for session token cookie
	const cookieHeader = request.headers.get("cookie") || "";
	const hasSessionToken = cookieHeader.includes(
		NEON_AUTH_SESSION_COOKIE_NAME,
	);

	// Check for stale session_data cookie (exists without session_token)
	const parsedCookies = parseCookies(cookieHeader);
	const hasSessionData = parsedCookies.has(
		NEON_AUTH_SESSION_DATA_COOKIE_NAME,
	);
	const hasStaleSessionData = hasSessionData && !hasSessionToken;

	let sessionData: SessionData = { session: null, user: null };
	let sessionCookies: string[] = [];

	if (hasSessionToken) {
		// Always issue the session lookup as a GET (it's a read). The triggering
		// request may use any method — a Next.js Server Action POSTs to the page
		// URL — and a non-GET would skip the get-session cache and hit the
		// GET-only upstream, spuriously logging the user out.
		const sessionRequest = new Request(request.url, {
			method: "GET",
			headers: stripBodyHeaders(request.headers),
		});

		const sessionResponse = await handleAuthProxyRequest({
			request: sessionRequest,
			path: "get-session",
			baseUrl,
			cookieSecret,
			sessionDataTtl,
			domain,
			sameSite,
			log,
		});

		// Parse session data from response
		if (sessionResponse.ok) {
			const data = await sessionResponse.json().catch((error) => {
				log.debug("[neon-auth] Failed to parse session response JSON", {
					component: "middleware",
					detail:
						error instanceof Error ? error.message : String(error),
				});
				return null;
			});
			if (data) {
				sessionData = data as SessionData;
			}
		}

		// Extract Set-Cookie headers (e.g., minted session_data cookie)
		sessionCookies = sessionResponse.headers.getSetCookie();
	}

	// Check if session is required for this route
	const checkResult = checkSessionRequired(
		pathname,
		skipRoutes,
		sameOriginLoginPathname,
		sessionData,
	);

	// Session valid or route doesn't require authentication
	if (checkResult.allowed) {
		return {
			action: "allow",
			headers: {
				[NEON_AUTH_HEADER_MIDDLEWARE_NAME]: "true",
			},
			cookies: sessionCookies,
		};
	}

	// No valid session and session is required - redirect to login
	// If stale session_data exists, clear it to prevent redirect loops
	const cookies: string[] = [];
	if (hasStaleSessionData) {
		cookies.push(
			serializeSetCookie({
				name: NEON_AUTH_SESSION_DATA_COOKIE_NAME,
				value: "",
				path: "/",
				domain,
				httpOnly: true,
				secure: true,
				sameSite: effectiveSameSite,
				maxAge: 0,
			}),
		);
	}

	if (resolvedLoginUrl.origin === requestUrl.origin) {
		const configuredLoginParamNames = new Set(
			resolvedLoginUrl.searchParams.keys(),
		);
		for (const [name, value] of requestUrl.searchParams) {
			if (!configuredLoginParamNames.has(name)) {
				resolvedLoginUrl.searchParams.append(name, value);
			}
		}
	}

	return {
		action: "redirect_login",
		redirectUrl: resolvedLoginUrl,
		cookies: cookies.length > 0 ? cookies : undefined,
	};
}
