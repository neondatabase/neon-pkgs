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

/** Runs `source`'s bearer guard on `request` and returns the {@link AuthOutcome}. */
export async function authenticateWith<O extends BearerAuthOptions>(
	source: BearerSource<O>,
	request: Request,
	opts: O,
): Promise<AuthOutcome> {
	const result = await source.requireBearerAuth(opts)(request);
	return result instanceof Response
		? { ok: false, response: result }
		: { ok: true, auth: result };
}
