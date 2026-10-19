/**
 * `@neon/oauth/express` — Express adapters for `@neon/oauth`. Express is imported for
 * types only; it is needed at runtime by the app.
 *
 * @module
 */
import type { Request, RequestHandler } from "express";
import type {
	AuthResult,
	AuthSource,
	ClientMetadataDocument,
	OAuthBearerOptions,
	OAuthClient,
	OAuthRouteOptions,
} from "./adapter";
import { nodeBearerAuth, nodeClientMetadata, nodeOAuthClient } from "./node";

/** A request that has passed `expressBearerAuth`. */
export type AuthedRequest = Request & { auth: AuthResult };

/**
 * Express middleware that requires a valid bearer token. On success it sets the verified
 * `AuthResult` on `req.auth` (read it as `(req as AuthedRequest).auth`) and calls `next()`;
 * otherwise it responds 401/403/503. Use it for a generic API; for an MCP server use
 * `expressMcp` from `@neon/oauth/mcp/express`.
 *
 * @param source A `createOAuth()` instance or `createVerifier()` verifier. `opts.audience` is
 *   required unless a `resource` was configured, else `OAuthConfigError` reaches Express' error handler.
 *
 * @example
 * ```ts
 * app.use("/api", expressBearerAuth(verifier));
 * app.get("/api/me", (req, res) => res.json({ user: (req as AuthedRequest).auth.sub }));
 * ```
 */
export function expressBearerAuth(
	source: AuthSource,
	opts: OAuthBearerOptions = {},
): RequestHandler {
	return nodeBearerAuth(source, opts);
}

/**
 * Express middleware that serves the sign-in routes `${basePath}/login`, `/callback` and
 * `/logout` for an OAuth client; every other request calls `next()`. `basePath` comes from the
 * client's `redirectUri`. Mount it with `app.use(expressOAuthClient(oauth.client))`. Throws
 * `OAuthConfigError` when called if `redirectUri` does not end in `/callback` or an explicit
 * `opts.basePath` disagrees with it.
 */
export function expressOAuthClient(
	client: OAuthClient,
	opts?: OAuthRouteOptions,
): RequestHandler {
	return nodeOAuthClient(client, opts);
}

/**
 * Express middleware that serves a `createClientMetadataDocument` result at the path of its
 * `client_id` (GET/HEAD); other requests call `next()`.
 */
export function expressClientMetadata(
	doc: ClientMetadataDocument,
): RequestHandler {
	return nodeClientMetadata(doc);
}
