/**
 * Framework-agnostic configuration types for Neon Auth
 */

import { ERRORS } from "./errors";
import type { NeonAuthLoggingInput, ResolvedNeonAuthLogging } from "./logger";

export type {
	NeonAuthLogger,
	NeonAuthLoggingInput,
	NeonAuthLogLevel,
} from "./logger";

/** Allowed values for the `SameSite` attribute on Neon Auth cookies. */
export type SessionCookieSameSite = "strict" | "lax" | "none";

/**
 * Session cookie configuration
 */
export interface SessionCookieConfig {
	/**
	 * Secret for signing session data cookies (enables session caching)
	 * Must be at least 32 characters for security.
	 *
	 * Generate a secure secret:
	 * ```bash
	 * openssl rand -base64 32
	 * ```
	 *
	 * @example process.env.NEON_AUTH_COOKIE_SECRET
	 */
	secret: string;

	/**
	 * Time-to-live for cached session data in seconds
	 *
	 * Controls how long session data is cached in a signed cookie before
	 * requiring re-validation with the upstream auth server.
	 * Note: this does not affect the session token cookie TTL.
	 *
	 * @default 300 (5 minutes)
	 * @example 60 // Cache for 1 minute
	 * @example 600 // Cache for 10 minutes
	 */
	sessionDataTtl?: number;

	/**
	 * Cookie domain for all Neon Auth cookies
	 *
	 * @default undefined (browser default - current domain only)
	 * @example '.example.com' // Share across subdomains
	 */
	domain?: string;

	/**
	 * `SameSite` for cookies set or rewritten by the server proxy (API route, middleware, RSC).
	 *
	 * - **`lax` (default)** — cookies are sent on top-level cross-site navigations, including OAuth callbacks.
	 * - **`strict`** — cookies are not sent on cross-site requests; opt in when cross-site navigation support is not needed.
	 * - **`none`** — use for third-party contexts (for example your app embedded in another site’s iframe); requires `Secure` (always applied for these cookies).
	 *
	 * @default 'lax'
	 */
	sameSite?: SessionCookieSameSite;
}

type NeonAuthBase = {
	/**
	 * Base URL for the Neon Auth server
	 * @example 'https://ep-xxxx.neonauth.us-east-1.aws.neon.tech'
	 */
	baseUrl: string;

	/**
	 * Cookie configuration
	 */
	cookies: SessionCookieConfig;
};

/**
 * Base configuration for Neon Auth server utilities.
 *
 * Combines connection settings with {@link NeonAuthLoggingInput} (`logger`, `logLevel`, including `'silent'`).
 */
export type NeonAuthConfig = NeonAuthBase & NeonAuthLoggingInput;

/**
 * Configuration for Neon Auth middleware.
 */
export type NeonAuthMiddlewareConfig = NeonAuthConfig & {
	/**
	 * URL to redirect to when user is not authenticated
	 * @default '/auth/sign-in'
	 */
	loginUrl?: string;
	/**
	 * Pre-resolved sink from {@link resolveNeonAuthLogging}. Set by {@link createNeonAuth} so middleware shares the same logging configuration as the API handler without resolving per request.
	 */
	log?: ResolvedNeonAuthLogging;
};

/**
 * Validates cookie configuration meets security requirements
 * @param cookies - The cookie configuration to validate
 * @throws Error if secret is too short (< 32 characters)
 */
export function validateCookieConfig(cookies: SessionCookieConfig): void {
	if (!cookies.secret) {
		throw new Error(ERRORS.MISSING_COOKIE_SECRET);
	}

	if (cookies.secret.length < 32) {
		throw new Error(ERRORS.COOKIE_SECRET_TOO_SHORT);
	}

	if (cookies.sessionDataTtl !== undefined && cookies.sessionDataTtl <= 0) {
		throw new Error(ERRORS.INVALID_SESSION_DATA_TTL);
	}
}
