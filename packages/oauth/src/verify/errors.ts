/**
 * Why a token was rejected, as the `code` of a `{ ok: false, reason: "invalid_token" }` result.
 * - `missing_token` / `malformed_header`: part of the union but never set by `verifyAccessToken`; the bearer guards answer a missing or malformed `Authorization` header with a 401 without a `code`.
 * - `missing_sub`: the token verified but has no `sub` claim.
 * - `expired`: past `exp` (allowing `clockTolerance`).
 * - `invalid_audience` / `invalid_issuer`: `aud` or `iss` does not match this verifier.
 * - `invalid_token`: anything else wrong with the token (bad signature, algorithm, structure).
 */
export type InvalidTokenCode =
	| "missing_token"
	| "malformed_header"
	| "missing_sub"
	| "expired"
	| "invalid_audience"
	| "invalid_issuer"
	| "invalid_token";

/** Base class of every error this package throws on purpose; catch it to handle all of them. */
export class OAuthError extends Error {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "OAuthError";
	}
}

/**
 * The package was configured wrongly: a programmer error, thrown synchronously when the factory
 * (`createOAuth`, `createVerifier`, `createMcpAuth`, ...) or a guard is created, not per request.
 * Fix the configuration; do not catch and retry.
 */
export class OAuthConfigError extends OAuthError {
	constructor(message: string) {
		super(message);
		this.name = "OAuthConfigError";
	}
}

/**
 * The authorization server could not be reached or trusted (network failure, timeout, 5xx, a
 * discovery document with the wrong issuer), so the operation could not complete. It is never
 * reported as "signed out" or "invalid token". HTTP guards and sign-in routes answer it as 503;
 * elsewhere, respond with a retry message rather than a login redirect. The underlying failure is `cause`.
 */
export class AuthServerUnavailableError extends OAuthError {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "AuthServerUnavailableError";
	}
}

/**
 * The caller's token is unusable. Consumers see it as a `{ ok: false, reason: "invalid_token", code }`
 * result, not as an exception; it is thrown only inside the package.
 */
export class InvalidTokenError extends OAuthError {
	constructor(
		readonly code: InvalidTokenCode,
		message: string,
	) {
		super(message);
		this.name = "InvalidTokenError";
	}
}
