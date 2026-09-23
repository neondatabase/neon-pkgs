import type { SessionCookieConfig } from "../config";
import {
	NEON_AUTH_SESSION_COOKIE_NAME,
	NEON_AUTH_SESSION_DATA_COOKIE_NAME,
} from "../constants";
import type { ResolvedNeonAuthLogging } from "../logger";
import { parseSetCookies, serializeSetCookie } from "../utils/cookies";
import { fetchSessionWithCookie, signSessionDataCookie } from "./operations";

/**
 * Core minting logic - creates session_data cookie from session token
 *
 * @param sessionTokenCookie - Session token cookie string (format: "name=value")
 * @param baseUrl - Auth server base URL
 * @param cookieConfig - Cookie configuration
 * @param log - Optional pre-resolved logger (honors `logLevel: 'silent'`).
 *              Falls back to `console.error` when omitted.
 * @returns Set-Cookie string or null on error
 */
async function mintSessionDataCookie(
	sessionTokenCookie: string,
	baseUrl: string,
	cookieConfig: SessionCookieConfig,
	log?: ResolvedNeonAuthLogging,
): Promise<string | null> {
	try {
		// Fetch session data from upstream using the session token
		const sessionData = await fetchSessionWithCookie(
			sessionTokenCookie,
			baseUrl,
			log,
		);

		if (!sessionData.session) {
			return null; // No valid session
		}

		// Sign the session data into a JWT cookie
		const { value: signedData, expiresAt } = await signSessionDataCookie(
			sessionData,
			cookieConfig.secret,
			cookieConfig.sessionDataTtl,
		);

		// Calculate Max-Age in seconds (relative time, immune to clock skew)
		const maxAge = Math.floor((expiresAt.getTime() - Date.now()) / 1000);

		// Serialize to Set-Cookie string
		return serializeSetCookie({
			name: NEON_AUTH_SESSION_DATA_COOKIE_NAME,
			value: signedData,
			path: "/",
			domain: cookieConfig.domain,
			httpOnly: true,
			secure: true,
			sameSite: cookieConfig.sameSite ?? "lax",
			maxAge,
		});
	} catch (error) {
		const errorMessage =
			error instanceof Error ? error.message : String(error);
		const meta = {
			error: errorMessage,
			...(process.env.NODE_ENV !== "production" && {
				stack: error instanceof Error ? error.stack : undefined,
			}),
		};
		if (log) {
			log.error(
				"[mintSessionDataCookie] Failed to mint session_data cookie:",
				meta,
			);
		} else {
			// Console fallback when no logger is plumbed through — matches legacy behavior.
			console.error(
				"[mintSessionDataCookie] Failed to mint session_data cookie:",
				meta,
			);
		}
		return null;
	}
}

/**
 * Utility A: Mint session_data cookie when session_token is updated by upstream
 *
 * Checks response headers for session_token in Set-Cookie, then mints session_data.
 * Handles token deletion (max-age=0) by returning deletion cookie.
 *
 * Use case: Response handling in proxy/middleware after upstream auth calls
 *
 * @param responseHeaders - Response headers from upstream auth server
 * @param baseUrl - Auth server base URL
 * @param cookieConfig - Cookie configuration
 * @returns Set-Cookie string for session_data or null if no action needed
 */
export async function mintSessionDataFromResponse(
	responseHeaders: Headers,
	baseUrl: string,
	cookieConfig: SessionCookieConfig,
	log?: ResolvedNeonAuthLogging,
): Promise<string | null> {
	// Parse upstream Set-Cookie headers and locate the session token by EXACT
	// name. The previous substring scans (`.includes('session_token')` and
	// `.includes('max-age=0')`) false-matched:
	//   - an unrelated cookie named `analytics_session_token_ref` triggered minting
	//   - a session cookie whose VALUE contained the literal `max-age=0`
	//     (alongside a real `Max-Age=3600`) was treated as a sign-out
	// See #161 review feedback (Andras FIX 2, correctness).
	const setCookieHeaders = responseHeaders.getSetCookie();
	let sessionTokenCookie: string | undefined;
	let sessionTokenIsDeletion = false;
	for (const cookieHeader of setCookieHeaders) {
		const parsed = parseSetCookies(cookieHeader).find(
			(cookie) => cookie.name === NEON_AUTH_SESSION_COOKIE_NAME,
		);
		if (parsed) {
			sessionTokenCookie = cookieHeader;
			sessionTokenIsDeletion =
				parsed.maxAge === 0 ||
				(parsed.expires !== undefined &&
					parsed.expires.getTime() <= Date.now());
			break;
		}
	}

	if (!sessionTokenCookie) {
		return null; // No session token in response, nothing to mint
	}

	if (sessionTokenIsDeletion) {
		// Return deletion cookie for session_data (matches sign-out)
		return serializeSetCookie({
			name: NEON_AUTH_SESSION_DATA_COOKIE_NAME,
			value: "",
			path: "/",
			domain: cookieConfig.domain,
			httpOnly: true,
			secure: true,
			sameSite: cookieConfig.sameSite ?? "lax",
			maxAge: 0,
		});
	}

	// Session token was set/updated - mint new session_data cookie
	return await mintSessionDataCookie(
		sessionTokenCookie,
		baseUrl,
		cookieConfig,
		log,
	);
}

/**
 * Utility B: Mint/refresh session_data cookie from existing session_token
 *
 * Extracts session_token from request cookies and mints a fresh session_data cookie.
 * Use case: Cache misses, expired cookies, proactive refresh
 *
 * @param sessionTokenCookie - Session token cookie string (format: "name=value")
 * @param baseUrl - Auth server base URL
 * @param cookieConfig - Cookie configuration
 * @returns Set-Cookie string for session_data or null on error
 */
export async function mintSessionDataFromToken(
	sessionTokenCookie: string,
	baseUrl: string,
	cookieConfig: SessionCookieConfig,
	log?: ResolvedNeonAuthLogging,
): Promise<string | null> {
	return await mintSessionDataCookie(
		sessionTokenCookie,
		baseUrl,
		cookieConfig,
		log,
	);
}
