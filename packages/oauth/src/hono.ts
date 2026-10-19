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

export type AuthVariables = { Variables: { auth: AuthResult } };

/** Bearer guard for any route. On success the verified `AuthResult` is at `c.get('auth')`. */
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

/** Serves `${basePath}/login|callback|logout`; other requests fall through. Mount with `app.use(honoOAuthClient(client))`. */
export function honoOAuthClient(
	client: OAuthClient,
	opts?: OAuthRouteOptions,
): MiddlewareHandler {
	resolveBasePath(client, opts);
	return async (c, next) =>
		(await routeOAuthClient(client, c.req.raw, opts)) ?? next();
}

/** Serves the document at the path of its `client_id`; other requests fall through. */
export function honoClientMetadata(
	doc: ClientMetadataDocument,
): MiddlewareHandler {
	return async (c, next) => routeClientMetadata(doc, c.req.raw) ?? next();
}
