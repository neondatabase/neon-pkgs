/**
 * `@neon/oauth/express` — Express middleware for sign-in, bearer-token guards and client metadata.
 * Express is imported for types only; the app provides it at runtime.
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

/** An Express request that has passed {@link expressBearerAuth}: `auth` is the verified token. */
export type AuthedRequest = Request & { auth: AuthResult };

/**
 * Express middleware that requires a valid bearer token, for a generic API. On success it sets the
 * verified {@link AuthResult} on `req.auth` and calls `next()`.
 *
 * Otherwise it sends the guard's error response (401 or 403 with a challenge, 503, or 500; see
 * `BearerGuard`). For an MCP server use `expressMcp` from `@neon/oauth/mcp/express`.
 *
 * @param source A `createOAuth()` instance or `createVerifier()` verifier.
 * @param opts Audience, required scopes, `resourceMetadataUrl` and `onError`. See {@link OAuthBearerOptions}.
 * @returns Middleware; read the result as `(req as AuthedRequest).auth`.
 * @throws {OAuthConfigError} Every request fails with it if neither `opts.audience` nor a configured
 *   `resource` is available. It is passed to `next(err)`.
 * @see {@link expressOAuthClient} for the sign-in routes.
 *
 * @example
 * ```ts
 * import express from "express";
 * import { expressBearerAuth, type AuthedRequest } from "@neon/oauth/express";
 * import { createVerifier } from "@neon/oauth/verify";
 *
 * const verifier = createVerifier({
 *   baseUrl: process.env.NEON_AUTH_BASE_URL!,
 *   resource: "https://api.example.com",
 * });
 *
 * const app = express();
 * app.use("/api", expressBearerAuth(verifier, { requiredScopes: ["read"] }));
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
 * Express middleware that serves the sign-in routes `{basePath}/login`, `/callback` and `/logout`
 * for an OAuth client; every other request calls `next()`.
 *
 * To read the session in an Express handler, build a Web `Request` from `req.originalUrl` and
 * `req.headers.cookie` and pass it to `client.getUser` (see the README).
 *
 * @param client The client from `createOAuth(...).client`.
 * @param opts See {@link OAuthRouteOptions}; `basePath` defaults to the prefix of the client's `redirectUri`.
 * @returns Middleware to mount with `app.use`.
 * @throws {OAuthConfigError} Immediately, if the `redirectUri` path does not end in `/callback` or
 *   an explicit `opts.basePath` disagrees with it.
 * @see `routeOAuthClient` for the framework-agnostic form.
 *
 * @example
 * ```ts
 * import express from "express";
 * import { createOAuth } from "@neon/oauth";
 * import { expressOAuthClient } from "@neon/oauth/express";
 *
 * const oauth = createOAuth({
 *   baseUrl: process.env.NEON_AUTH_BASE_URL!,
 *   clientId: process.env.NEON_AUTH_CLIENT_ID!,
 *   redirectUri: "https://app.example.com/api/auth/callback",
 *   cookies: { secret: process.env.NEON_AUTH_COOKIE_SECRET! },
 * });
 *
 * const app = express();
 * app.use(expressOAuthClient(oauth.client)); // serves /api/auth/login, /callback, /logout
 * ```
 */
export function expressOAuthClient(
	client: OAuthClient,
	opts?: OAuthRouteOptions,
): RequestHandler {
	return nodeOAuthClient(client, opts);
}

/**
 * Express middleware that serves a Client ID Metadata Document on GET and HEAD at the path of its
 * `client_id`; other requests call `next()`.
 *
 * @param doc The result of `createClientMetadataDocument`.
 * @see `routeClientMetadata` for the framework-agnostic form.
 *
 * @example
 * ```ts
 * import express from "express";
 * import { createClientMetadataDocument } from "@neon/oauth";
 * import { expressClientMetadata } from "@neon/oauth/express";
 *
 * const doc = createClientMetadataDocument({
 *   clientId: "https://app.example.com/oauth/client.json",
 *   clientName: "Reports",
 *   redirectUris: ["https://app.example.com/api/auth/callback"],
 * });
 *
 * const app = express();
 * app.use(expressClientMetadata(doc));
 * ```
 */
export function expressClientMetadata(
	doc: ClientMetadataDocument,
): RequestHandler {
	return nodeClientMetadata(doc);
}
