import { parseCookies } from "better-auth/cookies";
import {
	NEON_AUTH_SESSION_COOKIE_NAME,
	NEON_AUTH_SESSION_DATA_COOKIE_NAME,
} from "@/server/constants";
import type { SessionCookieConfig } from "../config";
import type { ResolvedNeonAuthLogging } from "../logger";
import { mintSessionDataFromToken } from "./minting";
import { fetchSessionWithCookie, getSessionDataFromCookie } from "./operations";

function emit(
	log: ResolvedNeonAuthLogging | undefined,
	level: "error" | "warn" | "debug",
	message: string,
	meta?: Record<string, unknown>,
): void {
	if (log) {
		log[level](message, meta);
		return;
	}
	// Console fallback is intentional: preserves legacy behavior when adapter
	// authors haven't plumbed a logger through. With a logger, the early
	// return above ensures we never reach these lines.
	if (meta && Object.keys(meta).length > 0) {
		console[level](message, meta);
	} else {
		console[level](message);
	}
}

/**
 * Attempts to retrieve session data from cookie cache
 * Returns Response with session data if cache hit, null otherwise
 *
 * If session_data cookie is missing or invalid, attempts to mint a new one
 * from the session_token cookie (reactive minting).
 *
 * This is the framework-agnostic session cache optimization used by API handlers.
 *
 * @param request - Standard Web API Request object
 * @param baseUrl - Auth server base URL for upstream calls
 * @param cookieConfig - Cookie configuration (secret, TTL, domain)
 * @returns Response with session data JSON if cache hit, null if miss/disabled
 */
export async function trySessionCache(
	request: Request,
	baseUrl: string,
	cookieConfig: SessionCookieConfig,
	log?: ResolvedNeonAuthLogging,
): Promise<Response | null> {
	const url = new URL(request.url);
	const disableCookieCache = url.searchParams.get("disableCookieCache");

	// Skip cache if explicitly disabled
	if (disableCookieCache === "true") {
		return null;
	}

	const cookieHeader = request.headers.get("cookie") || "";
	const hasSessionToken = cookieHeader.includes(
		NEON_AUTH_SESSION_COOKIE_NAME,
	);

	if (!hasSessionToken) {
		// No session token - ignore any stale session_data cookie
		return null;
	}

	// Parse cookies to check for session_data
	const parsedCookies = parseCookies(cookieHeader);
	const hasSessionData = parsedCookies.has(
		NEON_AUTH_SESSION_DATA_COOKIE_NAME,
	);

	// Helper to mint and return response with new cookie
	const mintAndReturn = async (): Promise<Response | null> => {
		const sessionTokenCookie = extractSessionTokenCookie(cookieHeader);
		if (!sessionTokenCookie) {
			return null;
		}

		const sessionDataCookieString = await mintSessionDataFromToken(
			sessionTokenCookie,
			baseUrl,
			cookieConfig,
			log,
		);

		if (!sessionDataCookieString) {
			return null; // Minting failed, fall through to upstream
		}

		// Fetch session data to return in response body
		try {
			const sessionData = await fetchSessionWithCookie(
				sessionTokenCookie,
				baseUrl,
				log,
			);
			if (!sessionData.session) {
				return null;
			}

			// Create response with session data and Set-Cookie header
			const response = Response.json(sessionData);
			response.headers.set("Set-Cookie", sessionDataCookieString);
			return response;
		} catch (error) {
			emit(
				log,
				"error",
				"[trySessionCache] Failed to fetch session after minting cookie:",
				{
					error:
						error instanceof Error ? error.message : String(error),
				},
			);
			return null;
		}
	};

	// Scenario 1: Missing session_data cookie
	if (!hasSessionData) {
		return await mintAndReturn();
	}

	// Scenario 2: Validate existing cookie
	try {
		const sessionData = await getSessionDataFromCookie(
			request,
			NEON_AUTH_SESSION_DATA_COOKIE_NAME,
			cookieConfig.secret,
			log,
		);

		if (sessionData?.session) {
			// Valid cache hit
			return Response.json(sessionData);
		}

		// Invalid/expired - mint new cookie
		return await mintAndReturn();
	} catch (error) {
		// Validation error - log and mint new cookie
		const errorMessage =
			error instanceof Error ? error.message : String(error);
		const errorName = error instanceof Error ? error.name : "Unknown";

		if (errorName === "JWTExpired") {
			emit(
				log,
				"debug",
				"[trySessionCache] Session cookie expired, minting new one:",
				{
					error: errorMessage,
					url: request.url,
				},
			);
		} else if (
			errorName === "JWTInvalid" ||
			errorName === "JWTClaimValidationFailed"
		) {
			emit(
				log,
				"warn",
				"[trySessionCache] Invalid session cookie, minting new one:",
				{
					error: errorMessage,
					url: request.url,
				},
			);
		} else {
			emit(
				log,
				"error",
				"[trySessionCache] Unexpected validation error:",
				{
					error: errorMessage,
					url: request.url,
				},
			);
		}

		// Try to mint fresh cookie
		return await mintAndReturn();
	}
}

/**
 * Extract session_token cookie value from cookie header
 * @internal
 */
function extractSessionTokenCookie(cookieHeader: string): string | null {
	const parsedCookies = parseCookies(cookieHeader);
	const sessionToken = parsedCookies.get(NEON_AUTH_SESSION_COOKIE_NAME);
	if (!sessionToken) {
		return null;
	}
	return `${NEON_AUTH_SESSION_COOKIE_NAME}=${sessionToken}`;
}
