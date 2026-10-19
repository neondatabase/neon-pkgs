/**
 * `@neon/oauth/next` — Next.js App Router route-handler adapters for `@neon/oauth`. Route
 * handlers are already Web `Request` -> `Response`, so these are thin. Server Components,
 * Server Actions and middleware are not covered.
 *
 * @module
 */
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
	clientMetadataResponse,
	resolveBasePath,
	routeOAuthClient,
} from "./adapter";

export type AuthedHandler<C> = (
	request: Request,
	auth: AuthResult,
	routeContext: C,
) => Response | Promise<Response>;

/** Wraps a route handler: 401/403/503 is returned for you, otherwise the handler runs with the verified `AuthResult`. */
export function withAuth<C = unknown>(
	source: AuthSource,
	handler: AuthedHandler<C>,
	opts: OAuthBearerOptions = {},
): (request: Request, routeContext: C) => Promise<Response> {
	return async (request, routeContext) => {
		const outcome = await authenticate(source, request, opts);
		return outcome.ok
			? handler(request, outcome.auth, routeContext)
			: outcome.response;
	};
}

/**
 * For `app/api/auth/[...oauth]/route.ts`: `export const { GET } = createRouteHandlers(oauth.client)`.
 * The route prefix comes from the client's `redirectUri` (`<origin>/api/auth/callback` serves `/api/auth/*`).
 * Route handlers only: reading the session in Server Components, Server Actions or middleware
 * is not covered by this adapter.
 */
export function createRouteHandlers(
	client: OAuthClient,
	opts: OAuthRouteOptions = {},
) {
	const basePath = resolveBasePath(client, opts);
	return {
		GET: async (request: Request): Promise<Response> =>
			(await routeOAuthClient(client, request, { basePath })) ??
			new Response("Not found", { status: 404 }),
	};
}

/**
 * For the route at the path of the document's `client_id`, e.g. `app/oauth/client.json/route.ts`:
 * `export const { GET } = createClientMetadataHandlers(doc)`.
 */
export function createClientMetadataHandlers(doc: ClientMetadataDocument) {
	return {
		GET: (_request: Request): Response => clientMetadataResponse(doc),
	};
}
