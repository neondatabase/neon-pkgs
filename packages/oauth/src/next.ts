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

/**
 * A route handler that runs only for authenticated requests: it receives the verified `AuthResult`
 * as its second argument. `C` is the framework's route context (e.g. `{ params: Promise<...> }`).
 */
export type AuthedHandler<C> = (
	request: Request,
	auth: AuthResult,
	routeContext: C,
) => Response | Promise<Response>;

/**
 * Wraps an App Router route handler so it needs a valid bearer token: 401/403/503 is returned
 * for you, otherwise `handler` runs with the verified `AuthResult`. Use it for a generic API; for
 * an MCP server use `withMcpAuth` from `@neon/oauth/mcp/next`.
 *
 * @param source A `createOAuth()` instance or `createVerifier()` verifier. `opts.audience` is
 *   required unless a `resource` was configured.
 *
 * @example
 * ```ts
 * // app/api/me/route.ts
 * export const GET = withAuth(verifier, (_req, auth) => Response.json({ user: auth.sub }));
 * ```
 */
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
 * Route handlers for the sign-in routes (`login`, `callback`, `logout`) of an OAuth client. Put
 * them in `app/api/auth/[...oauth]/route.ts`:
 * `export const { GET } = createRouteHandlers(oauth.client)`. The route prefix comes from the
 * client's `redirectUri` (`<origin>/api/auth/callback` serves `/api/auth/*`); other paths under it
 * answer 404. Throws `OAuthConfigError` when called if `redirectUri` does not end in `/callback`
 * or an explicit `opts.basePath` disagrees with it.
 *
 * Route handlers only: reading the session in Server Components, Server Actions or middleware
 * is not covered by this adapter; call `client.getUser(request)` where you have a `Request`.
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
 * Route handler that serves a `createClientMetadataDocument` result. Put it in the route at the
 * path of the document's `client_id`, e.g. `app/oauth/client.json/route.ts`:
 * `export const { GET } = createClientMetadataHandlers(doc)`.
 */
export function createClientMetadataHandlers(doc: ClientMetadataDocument) {
	return {
		GET: (_request: Request): Response => clientMetadataResponse(doc),
	};
}
