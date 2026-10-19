import type { BearerAuthOptions, BearerGuard } from "./bearer";
import type { AuthResult } from "./verifier";

/** Result of `authenticate`: the verified `auth`, or a `response` (401/403/503) that is ready to send. */
export type AuthOutcome =
	| { ok: true; auth: AuthResult }
	| { ok: false; response: Response };

/** Anything that can mint a bearer guard: an `OAuth` instance, a verifier or an MCP resource server. */
export interface BearerSource<O extends BearerAuthOptions> {
	requireBearerAuth(opts: O): BearerGuard;
}

/** Verifies the request's bearer token. On failure `response` is a ready 401/403/503 to send as-is. */
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
