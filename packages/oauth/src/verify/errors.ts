export type InvalidTokenCode =
	| "missing_token"
	| "malformed_header"
	| "missing_sub"
	| "expired"
	| "invalid_audience"
	| "invalid_issuer"
	| "invalid_token";

/** Base class of every error this package throws on purpose. */
export class OAuthError extends Error {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "OAuthError";
	}
}

/** The package was configured wrongly: a programmer error, thrown when the factory is called. */
export class OAuthConfigError extends OAuthError {
	constructor(message: string) {
		super(message);
		this.name = "OAuthConfigError";
	}
}

/** We could not reach or trust the authorization server, so the operation could not complete. Maps to HTTP 503. */
export class AuthServerUnavailableError extends OAuthError {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "AuthServerUnavailableError";
	}
}

/** The caller's token is unusable. Surfaced as a `{ ok: false, reason: "invalid_token" }` result; thrown only inside the package. */
export class InvalidTokenError extends OAuthError {
	constructor(
		readonly code: InvalidTokenCode,
		message: string,
	) {
		super(message);
		this.name = "InvalidTokenError";
	}
}
