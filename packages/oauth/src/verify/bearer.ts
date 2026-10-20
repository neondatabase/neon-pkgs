import { AuthServerUnavailableError } from "./errors";
import type { AuthResult, Verifier } from "./verifier";

/** Options shared by every bearer guard. */
export interface BearerAuthOptions {
	/** Scopes the token must all carry; a token missing any is answered 403 `insufficient_scope`. */
	requiredScopes?: string[];
	/**
	 * Called with the cause whenever the guard answers 5xx (authorization server unavailable, or
	 * an unexpected failure), for logging. 401 and 403 are expected outcomes and are not reported.
	 * A throwing callback is ignored.
	 */
	onError?: (error: unknown, request: Request) => void;
}

/** Options for guarding a generic API. An MCP server's audience is always its `resource`, so MCP guards take {@link BearerAuthOptions}. */
export interface OAuthBearerOptions extends BearerAuthOptions {
	/**
	 * This API's identifier: clients send it as `resource`, and Neon Auth stamps it into the token's `aud`.
	 * One of `audience` or the `resource` passed to `createOAuth` / `createVerifier` is required.
	 *
	 * @defaultValue the `resource` the verifier was created with
	 */
	audience?: string;
	/**
	 * Adds `resource_metadata` (RFC 9728) to `WWW-Authenticate` challenges. `true` derives the
	 * path-inserted well-known URL from the audience (see {@link protectedResourceMetadataUrl});
	 * a string is used verbatim.
	 *
	 * @defaultValue omitted: challenges carry no `resource_metadata`
	 */
	resourceMetadataUrl?: string | true;
}

/**
 * A framework-neutral bearer guard: given a `Request`, resolves to the verified {@link AuthResult}
 * or to a ready-to-send `Response`.
 *
 * The `Response` is 401 (missing or invalid token), 403 (insufficient scope), 503 (authorization
 * server unavailable) or 500 (unexpected failure). The 401 and 403 carry an RFC 6750
 * `WWW-Authenticate` challenge (with `resource_metadata` for MCP guards); the 5xx bodies never
 * include the cause, which goes to `onError`. The guard never throws; test the result with
 * `result instanceof Response`, or use `authenticate` from `@neon/oauth/adapter` for an
 * `{ ok, auth | response }` shape.
 */
export type BearerGuard = (request: Request) => Promise<AuthResult | Response>;

/**
 * Returns the RFC 9728 protected-resource metadata URL for `resource`, with the resource's path
 * inserted after the well-known prefix.
 *
 * `https://mcp.example.com/mcp` gives `https://mcp.example.com/.well-known/oauth-protected-resource/mcp`.
 * This is what `resourceMetadataUrl: true` puts in `WWW-Authenticate` challenges.
 *
 * @param resource The protected resource's absolute URL.
 * @throws {TypeError} If `resource` is not an absolute URL.
 */
export function protectedResourceMetadataUrl(resource: string): string {
	const u = new URL(resource);
	return new URL(
		`/.well-known/oauth-protected-resource${u.pathname === "/" ? "" : u.pathname.replace(/\/$/, "")}`,
		u.origin,
	).href;
}

/**
 * Creates a {@link BearerGuard} that checks the `Authorization: Bearer` header against an exact
 * `audience`. Use it when you already hold a verifier and know the audience; otherwise call the
 * verifier's `requireBearerAuth()`, which resolves the audience for you.
 *
 * 401 and 403 responses carry an RFC 6750 `WWW-Authenticate` challenge. 5xx response bodies never
 * include the cause, which goes to `options.onError`.
 *
 * @param verifier The verifier from `createVerifier`, used for key discovery and signature checks.
 * @param audience The `aud` the token must carry.
 * @param opts Required scopes, `onError` and `resourceMetadataUrl`.
 * @returns A guard that never throws.
 *
 * @example
 * ```ts
 * import { createBearerGuard, createVerifier } from "@neon/oauth/verify";
 *
 * const verifier = createVerifier({ baseUrl: process.env.NEON_AUTH_BASE_URL! });
 * const guard = createBearerGuard(verifier, "https://api.example.com", { requiredScopes: ["read"] });
 *
 * export default {
 *   async fetch(request: Request) {
 *     const result = await guard(request);
 *     if (result instanceof Response) return result;
 *     return Response.json({ user: result.sub });
 *   },
 * };
 * ```
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
