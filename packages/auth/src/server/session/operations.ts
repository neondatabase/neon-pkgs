import { parseCookies } from "better-auth/cookies";
import { SignJWT } from "jose";
import type { ResolvedNeonAuthLogging } from "@/server/logger";
import type {
	RequireSessionData,
	SessionData,
	SessionDataCookie,
} from "@/server/types";
import { validateSessionData } from "./validator";

// Default 5-minute TTL for session data cookie (in seconds)
export const DEFAULT_SESSION_CACHE_TTL_SECONDS = 300;
const JWS_ALGO = "HS256";

/**
 * Routes a log call through the injected `ResolvedNeonAuthLogging` sink when
 * provided, otherwise falls back to `console.*`. Keeps backward compatibility
 * for callers (including third-party adapter authors using `parseSessionData`
 * publicly) that have not yet plumbed a logger through.
 *
 * Without this indirection, `logLevel: 'silent'` on `createAuthServer` is
 * bypassed for session caching call sites — see #161 review feedback (Andras
 * item 6).
 */
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
 * Parse and validate date value, throwing descriptive error on failure
 * @internal
 */
function parseDate(dateValue: unknown, fieldName: string): Date {
	const date = new Date(dateValue as string);
	if (Number.isNaN(date.getTime())) {
		throw new TypeError(
			`Invalid date value for ${fieldName}: ${JSON.stringify(dateValue)}`,
		);
	}
	return date;
}

/**
 * Convert session data from /get-session into a signed cookie
 * @param sessionData - Session and user data from Auth server
 * @param secret - Secret for signing the cookie
 * @param ttlSeconds - Time-to-live in seconds (default: 300 = 5 minutes)
 * @returns Signed session data cookie
 */
export async function signSessionDataCookie(
	sessionData: RequireSessionData,
	secret: string,
	ttlSeconds: number = DEFAULT_SESSION_CACHE_TTL_SECONDS,
): Promise<SessionDataCookie> {
	const ttlMs = ttlSeconds * 1000;
	const expiresAt = Math.min(
		sessionData.session.expiresAt.getTime(),
		Date.now() + ttlMs,
	);

	const value = await signPayload(sessionData, expiresAt, secret);
	return { value, expiresAt: new Date(expiresAt) };
}

function signPayload(
	sessionData: SessionData,
	expiresAt: number,
	secret: string,
): Promise<string> {
	const encodedSecret = new TextEncoder().encode(secret);
	const expSeconds = Math.floor(expiresAt / 1000);

	// Sign the entire SessionData object (nested structure)
	return new SignJWT(sessionData)
		.setProtectedHeader({ alg: JWS_ALGO, typ: "JWT" })
		.setIssuedAt()
		.setExpirationTime(expSeconds)
		.setSubject(sessionData.user?.id ?? "anonymous")
		.sign(encodedSecret);
}

/**
 * Subset of the upstream JSON shape this parser actually inspects.
 * Kept open-ended for forward compatibility — adapter authors may receive
 * additional fields from newer Neon Auth server versions; the parser only
 * normalizes the documented dates and passes the rest through via spread.
 */
type RawSessionEnvelope = {
	session?: {
		expiresAt?: unknown;
		createdAt?: unknown;
		updatedAt?: unknown;
		[key: string]: unknown;
	} | null;
	user?: {
		createdAt?: unknown;
		updatedAt?: unknown;
		[key: string]: unknown;
	} | null;
};

/**
 * Parse session data from JSON, converting date strings to Date objects.
 *
 * Better Auth API returns ISO 8601 date strings; `JSON.parse()` does not
 * automatically convert these to `Date` objects, so manual conversion is
 * required.
 *
 * Adapter authors typically invoke this on responses returned by
 * {@link handleAuthProxyRequest} when populating framework context
 * (e.g. `c.var.auth` in Hono). Returns `{ session: null, user: null }` on
 * parse failure instead of throwing.
 *
 * @param json - Raw response body to parse (typically the JSON payload from
 *               `/api/auth/get-session`).
 * @param log  - Optional pre-resolved logger. When omitted, parse failures
 *               are reported via `console.error`. Pass the same `log` from
 *               your {@link NeonAuthServerConfig} to honor `logLevel: 'silent'`.
 *
 * @public
 */
export function parseSessionData(
	json: unknown,
	log?: ResolvedNeonAuthLogging,
): SessionData {
	// Handle null/undefined/missing response
	if (!json || typeof json !== "object") {
		return { session: null, user: null };
	}

	const data = json as RawSessionEnvelope;

	// Handle explicit null session
	if (!data.session || !data.user) {
		return { session: null, user: null };
	}

	// Validate and parse dates
	try {
		return {
			session: {
				...data.session,
				expiresAt: parseDate(
					data.session.expiresAt,
					"session.expiresAt",
				),
				createdAt: parseDate(
					data.session.createdAt,
					"session.createdAt",
				),
				updatedAt: parseDate(
					data.session.updatedAt,
					"session.updatedAt",
				),
			},
			user: {
				...data.user,
				createdAt: parseDate(data.user.createdAt, "user.createdAt"),
				updatedAt: parseDate(data.user.updatedAt, "user.updatedAt"),
			},
		} as SessionData;
	} catch (error) {
		emit(
			log,
			"error",
			"[parseSessionData] Failed to parse session dates:",
			{
				error: error instanceof Error ? error.message : String(error),
				hasSession: !!data.session,
				hasUser: !!data.user,
			},
		);

		// Return null session on parse error (graceful degradation)
		return { session: null, user: null };
	}
}

/**
 * Extract and validate session data from cookie header
 * Falls back to null on any error (caller should fetch from API)
 *
 * @param request - Request object with cookie header
 * @param cookieName - Name of session data cookie
 * @param cookieSecret - cookie secret for validation
 * @param log - Optional pre-resolved logger (honors `logLevel: 'silent'`).
 *              Falls back to `console.warn` / `console.error` when omitted.
 * @returns SessionData or null on validation failure
 */
export async function getSessionDataFromCookie(
	request: Request,
	cookieName: string,
	cookieSecret: string,
	log?: ResolvedNeonAuthLogging,
): Promise<SessionData | null> {
	try {
		const cookieHeader = request.headers.get("cookie");
		if (!cookieHeader) {
			return null;
		}

		const parsedCookies = parseCookies(cookieHeader);
		const sessionDataCookie = parsedCookies.get(cookieName);
		if (!sessionDataCookie) {
			return null;
		}

		// Validate cookie signature and expiry
		const result = await validateSessionData(
			sessionDataCookie,
			cookieSecret,
		);
		if (result.valid && result.payload) {
			return result.payload; // Valid cookie
		}

		// Cookie present but invalid - log for visibility
		emit(
			log,
			"warn",
			"[getSessionDataFromCookie] Invalid session cookie:",
			{
				error: result.error,
				cookieName,
			},
		);

		return null;
	} catch (error) {
		// Unexpected error during extraction/validation
		emit(
			log,
			"error",
			"[getSessionDataFromCookie] Unexpected validation error:",
			{
				error: error instanceof Error ? error.message : String(error),
				cookieName,
				...(process.env.NODE_ENV !== "production" && {
					stack: error instanceof Error ? error.stack : undefined,
				}),
			},
		);

		return null; // Fallback to API call
	}
}

/**
 * Fetch session data from upstream using session token cookie
 *
 * @param sessionTokenCookie - Session token cookie string (can be Set-Cookie header or "name=value" format)
 * @param baseUrl - Auth server base URL
 * @returns Session data from upstream
 */
export async function fetchSessionWithCookie(
	sessionTokenCookie: string,
	baseUrl: string,
	log?: ResolvedNeonAuthLogging,
): Promise<SessionData> {
	// Parse cookie value - handle both Set-Cookie header format and simple "name=value" format
	let cookieName: string;
	let cookieValue: string;

	if (sessionTokenCookie.includes("=")) {
		// Extract name and value from cookie string
		const parts = sessionTokenCookie.split(";")[0].trim(); // Get first part before any attributes
		const [name, ...valueParts] = parts.split("=");
		cookieName = name.trim();
		cookieValue = valueParts.join("=").trim(); // Rejoin in case value contains '='
	} else {
		throw new Error("Invalid session token cookie format");
	}

	if (!cookieName.includes("session_token")) {
		throw new Error("session_token not found in cookie");
	}

	const response = await fetch(`${baseUrl}/get-session`, {
		headers: {
			Cookie: `${cookieName}=${cookieValue}`,
		},
		signal: AbortSignal.timeout(3000), // 3s timeout
	});

	if (!response.ok) {
		throw new Error(
			`Failed to fetch session data: ${response.status} ${response.statusText}`,
		);
	}

	let body: unknown;
	try {
		body = await response.json();
	} catch (error) {
		throw new Error(
			`Failed to parse /get-session response as JSON: ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	return parseSessionData(body, log);
}
