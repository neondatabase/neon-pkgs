/**
 * `@neon/oauth/node` — `node:http` adapters for `@neon/oauth`.
 *
 * @module
 */
import type { IncomingMessage } from "node:http";
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
import {
	type FetchHandler,
	type NodeMiddleware,
	type NodeNext,
	nodeMiddleware,
	toNodeHandler,
} from "./internal/node";

export type { FetchHandler, NodeMiddleware, NodeNext };
export { nodeMiddleware, toNodeHandler };
/** A `node:http` request after `nodeBearerAuth` has run: `auth` is the verified token. */
export type AuthedIncomingMessage = IncomingMessage & { auth?: AuthResult };

/**
 * `node:http` middleware (`(req, res, next)`) that requires a valid bearer token. On success it
 * sets the verified `AuthResult` on `req.auth` (see `AuthedIncomingMessage`) and calls `next()`;
 * otherwise it responds 401/403/503. Use it for a generic API; for an MCP server use `nodeMcp`
 * from `@neon/oauth/mcp/node`.
 *
 * @param source A `createOAuth()` instance or `createVerifier()` verifier. `opts.audience` is
 *   required unless a `resource` was configured, else `OAuthConfigError` is passed to `next(err)`.
 */
export function nodeBearerAuth(
	source: AuthSource,
	opts: OAuthBearerOptions = {},
): NodeMiddleware {
	return nodeMiddleware(async (request, req) => {
		const outcome = await authenticate(source, request, opts);
		if (!outcome.ok) return outcome.response;
		(req as AuthedIncomingMessage).auth = outcome.auth;
		return undefined;
	});
}

/**
 * `node:http` middleware that serves the sign-in routes `${basePath}/login`, `/callback` and
 * `/logout` for an OAuth client; everything else calls `next()`. `basePath` comes from the
 * client's `redirectUri`. Throws `OAuthConfigError` when called if `redirectUri` does not end in
 * `/callback` or an explicit `opts.basePath` disagrees with it.
 */
export function nodeOAuthClient(
	client: OAuthClient,
	opts?: OAuthRouteOptions,
): NodeMiddleware {
	resolveBasePath(client, opts);
	return nodeMiddleware((request) => routeOAuthClient(client, request, opts));
}

/** `node:http` middleware that serves a `createClientMetadataDocument` result at the path of its `client_id` (GET/HEAD); everything else calls `next()`. */
export function nodeClientMetadata(
	doc: ClientMetadataDocument,
): NodeMiddleware {
	return nodeMiddleware((request) => routeClientMetadata(doc, request));
}
