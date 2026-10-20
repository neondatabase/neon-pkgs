/**
 * Why `verifyAccessToken` rejected a token: the `code` of its `{ ok: false, reason: "invalid_token" }` result.
 *
 * - `missing_sub`: the token verified but has no `sub` claim.
 * - `expired`: past `exp` (allowing `clockTolerance`).
 * - `invalid_audience` / `invalid_issuer`: `aud` or `iss` does not match this verifier.
 * - `invalid_token`: anything else wrong with the token (bad signature, disallowed algorithm, malformed).
 * - `missing_token` / `malformed_header`: never produced by `verifyAccessToken`. The bearer guards
 *   answer a missing or malformed `Authorization` header with a 401 `invalid_token` challenge, not
 *   one of these codes.
 */
export type InvalidTokenCode =
	| "missing_token"
	| "malformed_header"
	| "missing_sub"
	| "expired"
	| "invalid_audience"
	| "invalid_issuer"
	| "invalid_token";

/**
 * Base class of every error this package throws on purpose; catch it to handle all of them.
 *
 * `cause` holds the underlying failure when there is one.
 */
export class OAuthError extends Error {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "OAuthError";
	}
}

/**
 * Thrown when the package is configured incorrectly. This is a programmer error: fix the
 * configuration instead of catching and retrying.
 *
 * Thrown when `createOAuth`, `createVerifier`, `createMcpAuth`, `createClientMetadataDocument` or a
 * framework sign-in adapter is created, and when a bearer guard has no `audience` or `resource`:
 * `requireBearerAuth()` throws once, when the guard is created, while the framework guards and
 * `authenticate` build theirs per request, so every request fails (via `next(err)`, the framework's
 * error handler, or a rejected promise). A URL `clientId` against a server without Client ID
 * Metadata Document support is only known after discovery, so `startLogin`, `finishLogin` or a
 * token refresh throws it.
 */
export class OAuthConfigError extends OAuthError {
	constructor(message: string) {
		super(message);
		this.name = "OAuthConfigError";
	}
}

/**
 * Thrown when the authorization server could not be reached or trusted, so the operation could not
 * complete: network failure, timeout, an error response, or a discovery document with the wrong `issuer` or no
 * `jwks_uri`. It is never reported as "signed out" or "invalid token".
 *
 * Thrown by `getDiscovery`, `verifyAccessToken`, `startLogin`, `finishLogin`, and
 * `getAccessToken` / `withAccessToken` when a refresh is needed. HTTP guards and sign-in routes
 * answer it as 503; elsewhere, respond with a retry message rather than a login redirect.
 *
 * `cause` is the underlying failure.
 */
export class AuthServerUnavailableError extends OAuthError {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "AuthServerUnavailableError";
	}
}

/**
 * Describes why a token is unusable. Callers see it as a `{ ok: false, reason: "invalid_token", code }`
 * result of `verifyAccessToken`, not as an exception; it is thrown only inside the package.
 */
export class InvalidTokenError extends OAuthError {
	constructor(
		/** Why the token was rejected. */
		readonly code: InvalidTokenCode,
		message: string,
	) {
		super(message);
		this.name = "InvalidTokenError";
	}
}
