/**
 * `@neon/oauth/hono` — Hono adapters for `@neon/oauth`. Hono is imported for types
 * only; it is needed at runtime by the app, not by this package.
 *
 * @module
 */
import type { MiddlewareHandler } from "hono";
import type {
	AuthResult,
	AuthSource,
	ClientMetadataDocument,
	OAuthBearerOptions,
	OAuthClient,
	OAuthRouteOptions,
} from "./adapter";
import {
	authenticate,
	resolveBasePath,
	routeClientMetadata,
	routeOAuthClient,
} from "./adapter";

/** Hono context variables set by `honoBearerAuth`. Use as `new Hono<AuthVariables>()` to read `c.get('auth')` in handlers. */
export type AuthVariables = { Variables: { auth: AuthResult } };

/**
 * Hono middleware that requires a valid bearer token. On success it stores the verified
 * `AuthResult` at `c.get('auth')` and calls the next handler; otherwise it responds 401/403/503
 * with an RFC 6750 `WWW-Authenticate` challenge. Use it for a generic API; for an MCP server use
 * `honoMcp` from `@neon/oauth/mcp/hono`.
 *
 * @param source A `createOAuth()` instance or `createVerifier()` verifier. `opts.audience` is
 *   required unless a `resource` was configured, else `OAuthConfigError` is thrown on the first request.
 *
 * @example
 * ```ts
 * app.use("/api/*", honoBearerAuth(verifier, { requiredScopes: ["read"] }));
 * app.get("/api/me", (c) => c.json({ user: c.get("auth").sub }));
 * ```
 */
export function honoBearerAuth(
	source: AuthSource,
	opts: OAuthBearerOptions = {},
): MiddlewareHandler<AuthVariables> {
	return async (c, next) => {
		const outcome = await authenticate(source, c.req.raw, opts);
		if (!outcome.ok) return outcome.response;
		c.set("auth", outcome.auth);
		await next();
	};
}

/**
 * Hono middleware that serves the sign-in routes `${basePath}/login`, `/callback` and `/logout`
 * for an OAuth client; every other request falls through to the next handler. `basePath` comes
 * from the client's `redirectUri`. Mount it with `app.use(honoOAuthClient(oauth.client))`.
 * Throws `OAuthConfigError` when called if `redirectUri` does not end in `/callback` or an explicit
 * `opts.basePath` disagrees with it.
 */
export function honoOAuthClient(
	client: OAuthClient,
	opts?: OAuthRouteOptions,
): MiddlewareHandler {
	resolveBasePath(client, opts);
	return async (c, next) =>
		(await routeOAuthClient(client, c.req.raw, opts)) ?? next();
}

/**
 * Hono middleware that serves a `createClientMetadataDocument` result at the path of its
 * `client_id` (GET/HEAD); other requests fall through. Mount with `app.use(honoClientMetadata(doc))`.
 */
export function honoClientMetadata(
	doc: ClientMetadataDocument,
): MiddlewareHandler {
	return async (c, next) => routeClientMetadata(doc, c.req.raw) ?? next();
}
