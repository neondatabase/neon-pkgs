/** Prefix for all Neon Auth cookies */
export const NEON_AUTH_COOKIE_PREFIX = "__Secure-neon-auth";

/** Cookie name for cached session data (signed JWT) - used for server-side session caching */
export const NEON_AUTH_SESSION_DATA_COOKIE_NAME = `${NEON_AUTH_COOKIE_PREFIX}.local.session_data`;

/** Legacy misspelled OAuth challenge cookie retained during the server migration */
export const NEON_AUTH_LEGACY_SESSION_CHALLENGE_COOKIE_NAME = `${NEON_AUTH_COOKIE_PREFIX}.session_challange`;

/** Canonical cookie name for OAuth session challenge */
export const NEON_AUTH_SESSION_CHALLENGE_COOKIE_NAME = `${NEON_AUTH_COOKIE_PREFIX}.session_challenge`;

/** Cookie name for session token - the primary authentication cookie */
export const NEON_AUTH_SESSION_COOKIE_NAME = `${NEON_AUTH_COOKIE_PREFIX}.session_token`;
