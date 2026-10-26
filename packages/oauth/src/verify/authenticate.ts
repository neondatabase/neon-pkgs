import type { BearerAuthOptions, BearerGuard } from "./bearer";
import type { AuthResult } from "./verifier";

/**
 * Result of `authenticate`: `{ ok: true, auth }` with the verified token, or `{ ok: false, response }`
 * with a ready 401 (missing or invalid token), 403 (insufficient scope), 503 (authorization server
 * unavailable) or 500 (unexpected failure) `Response` to send as-is.
 */
export type AuthOutcome =
	| { ok: true; auth: AuthResult }
	| { ok: false; response: Response };

/** Anything that can create a bearer guard: an `OAuth` instance, a verifier or an `McpAuth`. */
export interface BearerSource<O extends BearerAuthOptions> {
	requireBearerAuth(opts: O): BearerGuard;
}

/**
 * Builds `source`'s bearer guard once and returns a function that runs it on each request.
 * Throws `OAuthConfigError` here, not per request, when the guard is misconfigured. No network I/O
 * happens until the first request.
 */
export function createAuthenticator<O extends BearerAuthOptions>(
	source: BearerSource<O>,
	opts: O,
): (request: Request) => Promise<AuthOutcome> {
	const guard = source.requireBearerAuth(opts);
	return async (request) => {
		const result = await guard(request);
		return result instanceof Response
			? { ok: false, response: result }
			: { ok: true, auth: result };
	};
}

/** Builds `source`'s bearer guard for this one call, runs it on `request` and returns the {@link AuthOutcome}. */
export async function authenticateWith<O extends BearerAuthOptions>(
	source: BearerSource<O>,
	request: Request,
	opts: O,
): Promise<AuthOutcome> {
	return createAuthenticator(source, opts)(request);
}
