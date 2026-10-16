import { AuthServerUnavailableError } from "./errors";
import type { AuthResult, Verifier } from "./verifier";

export interface BearerAuthOptions {
	requiredScopes?: string[];
	/**
	 * Called with the cause whenever the guard answers 5xx (authorization server unavailable, or
	 * an unexpected failure), for logging. 401 and 403 are expected outcomes and are not reported.
	 */
	onError?: (error: unknown, request: Request) => void;
}

/** Options for guarding a generic API, where the audience may come from the configured `resource`. */
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

/** Framework-neutral guard: the verified `AuthResult`, or a ready-to-send 401/403/503 `Response`. It never throws. */
export type BearerGuard = (request: Request) => Promise<AuthResult | Response>;

/** RFC 9728 well-known URL for a resource: the well-known prefix with the resource's path inserted. */
export function protectedResourceMetadataUrl(resource: string): string {
	const u = new URL(resource);
	return new URL(
		`/.well-known/oauth-protected-resource${u.pathname === "/" ? "" : u.pathname.replace(/\/$/, "")}`,
		u.origin,
	).href;
}

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

/** Runs a logging hook without letting it break the response. */
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
