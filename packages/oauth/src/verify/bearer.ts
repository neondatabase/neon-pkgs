import { AuthServerUnavailableError } from "./errors";
import type { AuthResult, Verifier } from "./verifier";

/** Options shared by every bearer guard. */
export interface BearerAuthOptions {
	/** Scopes the token must all carry; a token missing any is answered 403 `insufficient_scope`. */
	requiredScopes?: string[];
	/**
	 * Called with the cause whenever the guard answers 5xx (authorization server unavailable, or
	 * an unexpected failure), for logging. 401 and 403 are expected outcomes and are not reported.
	 */
	onError?: (error: unknown, request: Request) => void;
}

/** Options for guarding a generic API (as opposed to an MCP server, whose audience is always its `resource`). */
export interface OAuthBearerOptions extends BearerAuthOptions {
	/**
	 * This API's identifier. Clients send it as `resource`, and Neon Auth stamps it into the token's `aud`.
	 * Defaults to the `resource` passed to `createOAuth` / `createVerifier`; one of the two is required.
	 */
	audience?: string;
	/**
	 * Adds `resource_metadata` (RFC 9728) to `WWW-Authenticate` challenges. `true` derives the
	 * path-inserted well-known URL from the audience; a string is used verbatim. Off by default.
	 */
	resourceMetadataUrl?: string | true;
}

/**
 * Framework-neutral guard: resolves to the verified `AuthResult`, or a ready-to-send `Response`
 * (401 invalid or missing token, 403 insufficient scope, 503 authorization server unavailable,
 * 500 unexpected). It never throws; test with `result instanceof Response`, or use `authenticate`
 * from `@neon/oauth/adapter` to get `{ ok, auth | response }` instead.
 */
export type BearerGuard = (request: Request) => Promise<AuthResult | Response>;

/**
 * The RFC 9728 protected-resource metadata URL for `resource`: the well-known prefix with the
 * resource's path inserted (`https://host/mcp` gives `https://host/.well-known/oauth-protected-resource/mcp`).
 * This is what `resourceMetadataUrl: true` puts in `WWW-Authenticate` challenges.
 * Throws a `TypeError` if `resource` is not an absolute URL.
 */
export function protectedResourceMetadataUrl(resource: string): string {
	const u = new URL(resource);
	return new URL(
		`/.well-known/oauth-protected-resource${u.pathname === "/" ? "" : u.pathname.replace(/\/$/, "")}`,
		u.origin,
	).href;
}

/**
 * Builds a `BearerGuard` that checks the `Authorization: Bearer` header against `audience` using
 * `verifier`. Lower-level than `verifier.requireBearerAuth()` (which resolves the audience for
 * you); use it when you already have the verifier and the exact audience. 401/403 carry an RFC 6750
 * `WWW-Authenticate` challenge; the 5xx bodies never include the cause, which goes to `opts.onError`.
 */
export function createBearerGuard(
	verifier: Verifier,
	audience: string,
	opts: BearerAuthOptions & { resourceMetadataUrl?: string | true },
): BearerGuard {
	const required = opts.requiredScopes ?? [];
	const metadataUrl =
		opts.resourceMetadataUrl === true
			? protectedResourceMetadataUrl(audience)
			: opts.resourceMetadataUrl;

	// RFC 6750 challenge, in the same format as the MCP SDK's Express `requireBearerAuth`.
	// quoted-string values escape `\` and `"` with a backslash (RFC 9110 5.6.4).
	function challenge(
		status: 401 | 403,
		error: string,
		description: string,
		extra = "",
	): Response {
		const params =
			`Bearer error="${error}", error_description="${quoted(description)}"${extra}` +
			(metadataUrl ? `, resource_metadata="${quoted(metadataUrl)}"` : "");
		return Response.json(
			{ error, error_description: description },
			{ status, headers: { "WWW-Authenticate": params } },
		);
	}

	return async (request) => {
		try {
			const token = bearerToken(request);
			if (!token.ok)
				return challenge(401, "invalid_token", token.message);
			const result = await verifier.verifyAccessToken(
				token.value,
				audience,
			);
			if (!result.ok)
				return challenge(401, "invalid_token", result.message);
			const missing = required.filter(
				(s) => !result.auth.scopes.includes(s),
			);
			if (missing.length > 0) {
				return challenge(
					403,
					"insufficient_scope",
					`Missing required scope: ${missing.join(" ")}`,
					`, scope="${quoted(required.join(" "))}"`,
				);
			}
			return result.auth;
		} catch (err) {
			report(opts.onError, err, request);
			const unavailable = err instanceof AuthServerUnavailableError;
			return Response.json(
				{
					error: "server_error",
					// The cause (URLs, upstream status) goes to `onError`, not to the caller.
					error_description: unavailable
						? "Authorization server unavailable"
						: "Internal error",
				},
				{ status: unavailable ? 503 : 500 },
			);
		}
	};
}

/** Calls an `onError` hook without letting a throwing logger break the response. */
export function report(
	onError: ((error: unknown, request: Request) => void) | undefined,
	error: unknown,
	request: Request,
): void {
	try {
		onError?.(error, request);
	} catch {
		// A failing logger must not turn a handled error into an unhandled one.
	}
}

const quoted = (value: string): string => value.replace(/["\\]/g, "\\$&");

function bearerToken(
	request: Request,
): { ok: true; value: string } | { ok: false; message: string } {
	const header = request.headers.get("authorization");
	if (!header) return { ok: false, message: "Missing Authorization header" };
	const [type, token] = header.split(" ");
	if (type.toLowerCase() !== "bearer" || !token) {
		return {
			ok: false,
			message:
				"Invalid Authorization header format, expected 'Bearer TOKEN'",
		};
	}
	return { ok: true, value: token };
}
