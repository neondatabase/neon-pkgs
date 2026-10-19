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

/** Bearer guard for any route. On success the verified `AuthResult` is at `req.auth`. */
export function expressBearerAuth(
	source: AuthSource,
	opts: OAuthBearerOptions = {},
): RequestHandler {
	return nodeBearerAuth(source, opts);
}

/** Serves `${basePath}/login|callback|logout`; other requests fall through. */
export function expressOAuthClient(
	client: OAuthClient,
	opts?: OAuthRouteOptions,
): RequestHandler {
	return nodeOAuthClient(client, opts);
}

/** Serves the document at the path of its `client_id`; other requests fall through. */
export function expressClientMetadata(
	doc: ClientMetadataDocument,
): RequestHandler {
	return nodeClientMetadata(doc);
}
