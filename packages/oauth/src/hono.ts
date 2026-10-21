/**
 * `@neon/oauth/hono` — Hono middleware for sign-in, bearer-token guards and client metadata.
 * Hono is imported for types only; the app provides it at runtime.
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

/** Hono context variables set by {@link honoBearerAuth}. Create the app as `new Hono<AuthVariables>()` to read `c.get("auth")` in handlers. */
export type AuthVariables = { Variables: { auth: AuthResult } };

/**
 * Hono middleware that requires a valid bearer token, for a generic API. On success it stores the
 * verified {@link AuthResult} at `c.get("auth")` and calls the next handler.
 *
 * Otherwise it sends the guard's error response (401 or 403 with a challenge, 503, or 500; see
 * `BearerGuard`). For an MCP server use `honoMcp` from `@neon/oauth/mcp/hono`.
 *
 * @param source A `createOAuth()` instance or `createVerifier()` verifier.
 * @param opts Audience, required scopes, `resourceMetadataUrl` and `onError`. See {@link OAuthBearerOptions}.
 * @returns Middleware typed with {@link AuthVariables}.
 * @throws {OAuthConfigError} Every request fails with it if neither `opts.audience` nor a configured
 *   `resource` is available. Hono passes it to its error handler.
 * @see {@link honoOAuthClient} for the sign-in routes.
 *
 * @example
 * ```ts
 * import { Hono } from "hono";
 * import { honoBearerAuth, type AuthVariables } from "@neon/oauth/hono";
 * import { createVerifier } from "@neon/oauth/verify";
 *
 * const verifier = createVerifier({
 *   baseUrl: process.env.NEON_AUTH_BASE_URL!,
 *   resource: "https://api.example.com",
 * });
 *
 * const app = new Hono<AuthVariables>();
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
 * Hono middleware that serves the sign-in routes `{basePath}/login`, `/callback` and `/logout`
 * for an OAuth client; every other request falls through to the next handler.
 *
 * @param client The client from `createOAuth(...).client`.
 * @param opts See {@link OAuthRouteOptions}; `basePath` defaults to the prefix of the client's `redirectUri`.
 * @returns Middleware to mount with `app.use`.
 * @throws {OAuthConfigError} Immediately, if the `redirectUri` path does not end in `/callback` or
 *   an explicit `opts.basePath` disagrees with it.
 * @see {@link routeOAuthClient} for the framework-agnostic form.
 *
 * @example
 * ```ts
 * import { Hono } from "hono";
 * import { createOAuth } from "@neon/oauth";
 * import { honoOAuthClient } from "@neon/oauth/hono";
 *
 * const oauth = createOAuth({
 *   baseUrl: process.env.NEON_AUTH_BASE_URL!,
 *   clientId: process.env.NEON_AUTH_CLIENT_ID!,
 *   redirectUri: "https://app.example.com/api/auth/callback",
 *   cookies: { secret: process.env.NEON_AUTH_COOKIE_SECRET! },
 * });
 *
 * const app = new Hono();
 * app.use(honoOAuthClient(oauth.client)); // serves /api/auth/login, /callback, /logout
 * app.get("/me", async (c) => {
 *   const result = await oauth.client.getUser(c.req.raw);
 *   return result.ok ? c.json(result.user) : c.json({ error: result.reason }, 401);
 * });
 * ```
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
 * Hono middleware that serves a Client ID Metadata Document on GET and HEAD at the path of its
 * `client_id`; other requests fall through.
 *
 * @param doc The result of `createClientMetadataDocument`.
 * @see {@link routeClientMetadata} for the framework-agnostic form.
 *
 * @example
 * ```ts
 * import { Hono } from "hono";
 * import { createClientMetadataDocument } from "@neon/oauth";
 * import { honoClientMetadata } from "@neon/oauth/hono";
 *
 * const doc = createClientMetadataDocument({
 *   clientId: "https://app.example.com/oauth/client.json",
 *   clientName: "Reports",
 *   redirectUris: ["https://app.example.com/api/auth/callback"],
 * });
 *
 * const app = new Hono();
 * app.use(honoClientMetadata(doc));
 * ```
 */
export function honoClientMetadata(
	doc: ClientMetadataDocument,
): MiddlewareHandler {
	return async (c, next) => routeClientMetadata(doc, c.req.raw) ?? next();
}
