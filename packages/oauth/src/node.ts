/**
 * `@neon/oauth/node` — `node:http` adapters for `@neon/oauth`.
 *
 * @module
 */
import type { IncomingMessage } from "node:http";
import type {
	AuthResult,
	AuthSource,
	OAuthBearerOptions,
	OAuthClient,
	OAuthRouteOptions,
} from "./adapter";
import { authenticate, resolveBasePath, routeOAuthClient } from "./adapter";
import {
	type FetchHandler,
	type NodeMiddleware,
	type NodeNext,
	nodeMiddleware,
	toNodeHandler,
} from "./internal/node";

export type { FetchHandler, NodeMiddleware, NodeNext };
export { nodeMiddleware, toNodeHandler };
export type AuthedIncomingMessage = IncomingMessage & { auth?: AuthResult };

/** Bearer guard. On success the verified `AuthResult` is at `req.auth` and `next()` is called. */
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

/** Serves `${basePath}/login|callback|logout`; everything else calls `next()`. */
export function nodeOAuthClient(
	client: OAuthClient,
	opts?: OAuthRouteOptions,
): NodeMiddleware {
	resolveBasePath(client, opts);
	return nodeMiddleware((request) => routeOAuthClient(client, request, opts));
}
