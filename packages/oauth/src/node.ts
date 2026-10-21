/**
 * `@neon/oauth/node` — `node:http` middleware for sign-in, bearer-token guards and client
 * metadata, plus the helpers they are built on.
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
/** A `node:http` request after {@link nodeBearerAuth} has run: `auth` is the verified token. */
export type AuthedIncomingMessage = IncomingMessage & { auth?: AuthResult };

/**
 * `node:http` middleware (`(req, res, next)`) that requires a valid bearer token, for a generic
 * API. On success it sets the verified {@link AuthResult} on `req.auth` and calls `next()`.
 *
 * Otherwise it sends the guard's error response (401 or 403 with a challenge, 503, or 500; see
 * `BearerGuard`). For an MCP server use `nodeMcp` from `@neon/oauth/mcp/node`.
 *
 * @param source A `createOAuth()` instance or `createVerifier()` verifier.
 * @param opts Audience, required scopes, `resourceMetadataUrl` and `onError`. See {@link OAuthBearerOptions}.
 * @returns Middleware; read the result from `req.auth` (see {@link AuthedIncomingMessage}).
 * @throws {OAuthConfigError} Every request fails with it if neither `opts.audience` nor a configured
 *   `resource` is available. It is passed to `next(err)`.
 * @see {@link nodeOAuthClient} for the sign-in routes.
 *
 * @example
 * ```ts
 * import { createServer } from "node:http";
 * import { nodeBearerAuth, type AuthedIncomingMessage } from "@neon/oauth/node";
 * import { createVerifier } from "@neon/oauth/verify";
 *
 * const verifier = createVerifier({
 *   baseUrl: process.env.NEON_AUTH_BASE_URL!,
 *   resource: "https://api.example.com",
 * });
 * const guard = nodeBearerAuth(verifier, { requiredScopes: ["read"] });
 *
 * createServer((req, res) =>
 *   guard(req, res, (err) => {
 *     if (err) {
 *       res.statusCode = 500; // e.g. a missing audience: OAuthConfigError
 *       return res.end();
 *     }
 *     const { auth } = req as Required<AuthedIncomingMessage>;
 *     res.setHeader("content-type", "application/json");
 *     res.end(JSON.stringify({ user: auth.sub }));
 *   }),
 * ).listen(3000);
 * ```
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
 * `node:http` middleware that serves the sign-in routes `{basePath}/login`, `/callback` and
 * `/logout` for an OAuth client; every other request calls `next()`.
 *
 * To read the session in a handler, build a Web `Request` from `req.url` and `req.headers.cookie`
 * and pass it to `client.getUser` (see the README).
 *
 * @param client The client from `createOAuth(...).client`.
 * @param opts See {@link OAuthRouteOptions}; `basePath` defaults to the prefix of the client's `redirectUri`.
 * @returns A `(req, res, next)` middleware.
 * @throws {OAuthConfigError} Immediately, if the `redirectUri` path does not end in `/callback` or
 *   an explicit `opts.basePath` disagrees with it.
 * @see {@link routeOAuthClient} for the framework-agnostic form.
 *
 * @example
 * ```ts
 * import { createServer } from "node:http";
 * import { createOAuth } from "@neon/oauth";
 * import { nodeOAuthClient } from "@neon/oauth/node";
 *
 * const oauth = createOAuth({
 *   baseUrl: process.env.NEON_AUTH_BASE_URL!,
 *   clientId: process.env.NEON_AUTH_CLIENT_ID!,
 *   redirectUri: "https://app.example.com/api/auth/callback",
 *   cookies: { secret: process.env.NEON_AUTH_COOKIE_SECRET! },
 * });
 * const signIn = nodeOAuthClient(oauth.client);
 *
 * createServer((req, res) =>
 *   signIn(req, res, (err) => {
 *     res.statusCode = err ? 500 : 404; // not a sign-in route
 *     res.end();
 *   }),
 * ).listen(3000);
 * ```
 */
export function nodeOAuthClient(
	client: OAuthClient,
	opts?: OAuthRouteOptions,
): NodeMiddleware {
	resolveBasePath(client, opts);
	return nodeMiddleware((request) => routeOAuthClient(client, request, opts));
}

/**
 * `node:http` middleware that serves a Client ID Metadata Document on GET and HEAD at the path of
 * its `client_id`; everything else calls `next()`.
 *
 * @param doc The result of `createClientMetadataDocument`.
 * @returns A `(req, res, next)` middleware.
 * @see {@link routeClientMetadata} for the framework-agnostic form.
 *
 * @example
 * ```ts
 * import { createServer } from "node:http";
 * import { createClientMetadataDocument } from "@neon/oauth";
 * import { nodeClientMetadata } from "@neon/oauth/node";
 *
 * const doc = createClientMetadataDocument({
 *   clientId: "https://app.example.com/oauth/client.json",
 *   clientName: "Reports",
 *   redirectUris: ["https://app.example.com/api/auth/callback"],
 * });
 * const metadata = nodeClientMetadata(doc);
 *
 * createServer((req, res) =>
 *   metadata(req, res, (err) => {
 *     res.statusCode = err ? 500 : 404; // not the metadata document
 *     res.end();
 *   }),
 * ).listen(3000);
 * ```
 */
export function nodeClientMetadata(
	doc: ClientMetadataDocument,
): NodeMiddleware {
	return nodeMiddleware((request) => routeClientMetadata(doc, request));
}
