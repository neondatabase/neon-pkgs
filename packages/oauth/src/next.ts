/**
 * `@neon/oauth/next` — Next.js App Router route-handler adapters for sign-in, bearer-token guards
 * and client metadata. Route handlers are already Web `Request` to `Response`, so these are thin.
 * Server Components, Server Actions and middleware are not covered.
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
 * A route handler that runs only for authenticated requests.
 *
 * It receives the verified {@link AuthResult} as its second argument and the framework's route
 * context (`C`, e.g. `{ params: Promise<{ id: string }> }`) as its third.
 */
export type AuthedHandler<C> = (
	request: Request,
	auth: AuthResult,
	routeContext: C,
) => Response | Promise<Response>;

/**
 * Wraps an App Router route handler so it needs a valid bearer token, for a generic API.
 *
 * A missing or invalid token gets the guard's error response (401 or 403 with a challenge, 503, or
 * 500; see `BearerGuard`); otherwise `handler` runs with the verified
 * {@link AuthResult}. For an MCP server use `withMcpAuth` from `@neon/oauth/mcp/next`.
 *
 * @typeParam C The route context type, e.g. `{ params: Promise<{ id: string }> }`.
 * @param source A `createOAuth()` instance or `createVerifier()` verifier.
 * @param handler Runs only for authenticated requests; see {@link AuthedHandler}.
 * @param opts Audience, required scopes, `resourceMetadataUrl` and `onError`. See {@link OAuthBearerOptions}.
 * @returns A route handler `(request, routeContext) => Promise<Response>` to export as `GET`, `POST`, ...
 * @throws {OAuthConfigError} Every request fails with it if neither `opts.audience` nor a configured
 *   `resource` is available. The returned promise rejects.
 *
 * @example
 * ```ts
 * // app/api/things/[id]/route.ts
 * import { withAuth } from "@neon/oauth/next";
 * import { createVerifier } from "@neon/oauth/verify";
 *
 * const verifier = createVerifier({
 *   baseUrl: process.env.NEON_AUTH_BASE_URL!,
 *   resource: "https://api.example.com",
 * });
 *
 * export const GET = withAuth(
 *   verifier,
 *   async (_request, auth, { params }: { params: Promise<{ id: string }> }) =>
 *     Response.json({ user: auth.sub, id: (await params).id }),
 *   { requiredScopes: ["read"] },
 * );
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
 * Route handlers for the sign-in routes (`login`, `callback`, `logout`) of an OAuth client.
 *
 * Export them from a catch-all route under the prefix of the client's `redirectUri`
 * (`https://app.example.com/api/auth/callback` serves `/api/auth/*`); other paths under it answer
 * 404. Only route handlers are covered: in Server Components, Server Actions or middleware, call
 * `client.getUser(request)` where you have a `Request`.
 *
 * @param client The client from `createOAuth(...).client`.
 * @param opts See {@link OAuthRouteOptions}; `basePath` defaults to the prefix of the client's `redirectUri`.
 * @returns `{ GET }`, to destructure as the route's exports.
 * @throws {OAuthConfigError} Immediately, if the `redirectUri` path does not end in `/callback` or
 *   an explicit `opts.basePath` disagrees with it.
 * @see {@link routeOAuthClient} for the framework-agnostic form.
 *
 * @example
 * ```ts
 * // app/api/auth/[...oauth]/route.ts
 * import { createOAuth } from "@neon/oauth";
 * import { createRouteHandlers } from "@neon/oauth/next";
 *
 * const oauth = createOAuth({
 *   baseUrl: process.env.NEON_AUTH_BASE_URL!,
 *   clientId: process.env.NEON_AUTH_CLIENT_ID!,
 *   redirectUri: "https://app.example.com/api/auth/callback",
 *   cookies: { secret: process.env.NEON_AUTH_COOKIE_SECRET! },
 * });
 *
 * export const { GET } = createRouteHandlers(oauth.client);
 * ```
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
 * Route handler that serves a Client ID Metadata Document. Export it from the route at the path of
 * the document's `client_id`.
 *
 * @param doc The result of `createClientMetadataDocument`.
 * @returns `{ GET }`, to destructure as the route's exports.
 * @see `routeClientMetadata` for the framework-agnostic form.
 *
 * @example
 * ```ts
 * // app/oauth/client.json/route.ts
 * import { createClientMetadataDocument } from "@neon/oauth";
 * import { createClientMetadataHandlers } from "@neon/oauth/next";
 *
 * const doc = createClientMetadataDocument({
 *   clientId: "https://app.example.com/oauth/client.json",
 *   clientName: "Reports",
 *   redirectUris: ["https://app.example.com/api/auth/callback"],
 * });
 *
 * export const { GET } = createClientMetadataHandlers(doc);
 * ```
 */
export function createClientMetadataHandlers(doc: ClientMetadataDocument) {
	return {
		GET: (_request: Request): Response => clientMetadataResponse(doc),
	};
}
