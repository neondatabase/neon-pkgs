/**
 * `@neon/oauth/adapter` — the contract every framework adapter is built on.
 *
 * The functions here speak Web `Request`/`Response`; an adapter only converts its framework's
 * request and response to and from these, and does not reimplement routing or challenges. Use
 * them directly for runtimes with no adapter (Bun, Deno, Workers, a plain fetch handler).
 *
 * @module
 */

import type { OAuthClient } from "./client";
import type { ClientMetadataDocument } from "./client/metadata-document";
import type { OAuth } from "./index";
import type { McpAuth } from "./mcp/resource-server";
import {
	type AuthOutcome,
	authenticateWith,
	type BearerSource,
} from "./verify/authenticate";
import type { BearerAuthOptions, OAuthBearerOptions } from "./verify/bearer";
import { OAuthConfigError } from "./verify/errors";
import type { AuthResult } from "./verify/verifier";

/**
 * What the API guards (`honoBearerAuth`, `expressBearerAuth`, `withAuth`, `nodeBearerAuth`,
 * `authenticate`) accept as their first argument: a `createOAuth()` instance or a
 * `createVerifier()` verifier. An API-only server therefore never loads the sign-in client.
 */
export type AuthSource = BearerSource<OAuthBearerOptions>;

export type {
	AuthOutcome,
	AuthResult,
	ClientMetadataDocument,
	McpAuth,
	OAuth,
	OAuthBearerOptions,
	OAuthClient,
};

/**
 * Checks the bearer token of a Web `Request` and returns the verified token or a ready error
 * `Response`; use it to guard a route in a framework this package has no adapter for.
 *
 * Prefer the framework guards (`honoBearerAuth`, `expressBearerAuth`, `withAuth`, `nodeBearerAuth`,
 * `honoMcp`, ...) when one exists: they call this and wire the result into the framework.
 *
 * @param source A `createOAuth()` instance or `createVerifier()` verifier (the audience then comes
 *   from `opts.audience` or the configured `resource`), or the result of `createMcpAuth()` (the
 *   audience and `resource_metadata` challenge come from it).
 * @param request The incoming request; only its `Authorization` header is read.
 * @param opts Required scopes, `audience` (not for MCP sources), `resourceMetadataUrl` and `onError`.
 * @returns `{ ok: true, auth }` with the verified {@link AuthResult}, or `{ ok: false, response }`
 *   with a 401 (missing or invalid token), 403 (missing scope), 503 (authorization server
 *   unavailable) or 500 (unexpected failure) `Response` to send as-is. A throwing `opts.onError`
 *   is ignored.
 * @throws {OAuthConfigError} If neither `opts.audience` nor a configured `resource` is available
 *   (verifier and `createOAuth()` sources only).
 * @see {@link routeOAuthClient} for the sign-in routes.
 *
 * @example
 * ```ts
 * import { authenticate } from "@neon/oauth/adapter";
 * import { createVerifier } from "@neon/oauth/verify";
 *
 * const verifier = createVerifier({
 *   baseUrl: process.env.NEON_AUTH_BASE_URL!,
 *   resource: "https://api.example.com",
 * });
 *
 * export default {
 *   async fetch(request: Request) {
 *     const out = await authenticate(verifier, request, { requiredScopes: ["read"] });
 *     if (!out.ok) return out.response;
 *     return Response.json({ user: out.auth.sub });
 *   },
 * };
 * ```
 */
export function authenticate(
	source: McpAuth,
	request: Request,
	opts?: BearerAuthOptions,
): Promise<AuthOutcome>;
export function authenticate(
	source: AuthSource,
	request: Request,
	opts?: OAuthBearerOptions,
): Promise<AuthOutcome>;
export function authenticate(
	source: McpAuth | AuthSource,
	request: Request,
	opts: BearerAuthOptions | OAuthBearerOptions = {},
): Promise<AuthOutcome> {
	return authenticateWith(
		source as BearerSource<BearerAuthOptions>,
		request,
		opts,
	);
}

/** Options for the sign-in route helpers (`routeOAuthClient`, `honoOAuthClient`, `createRouteHandlers`, ...). */
export interface OAuthRouteOptions {
	/**
	 * Path prefix of `/login`, `/callback` and `/logout`. When given it must equal the prefix of the
	 * client's `redirectUri` path, so the callback route and the registered redirect cannot drift
	 * apart; use `''` for routes at the root.
	 *
	 * @defaultValue the prefix of the client's `redirectUri` path (`https://app.example.com/api/auth/callback` serves `/api/auth/*`)
	 */
	basePath?: string;
}

const CALLBACK_SUFFIX = "/callback";

/**
 * Returns the sign-in route prefix for `client`, derived from its `redirectUri`. Call it once when
 * building an adapter so a misconfiguration fails at startup, not on the first request.
 *
 * @param client The client from `createOAuth(...).client`.
 * @param opts An explicit `basePath`, which is only checked against the derived prefix.
 * @returns The prefix without a trailing slash; `''` when the callback is at the root.
 * @throws {OAuthConfigError} If the `redirectUri` path does not end in `/callback`, or an explicit
 *   `basePath` disagrees with it.
 */
export function resolveBasePath(
	client: OAuthClient,
	opts: OAuthRouteOptions = {},
): string {
	const redirectPath = new URL(client.redirectUri).pathname;
	if (!redirectPath.endsWith(CALLBACK_SUFFIX)) {
		throw new OAuthConfigError(
			`redirectUri path must end in "${CALLBACK_SUFFIX}" because the callback route is served at <basePath>${CALLBACK_SUFFIX}, got "${client.redirectUri}".`,
		);
	}
	const derived = redirectPath.slice(0, -CALLBACK_SUFFIX.length);
	if (opts.basePath === undefined) return derived;
	const explicit = opts.basePath.replace(/\/$/, "");
	if (explicit !== derived) {
		throw new OAuthConfigError(
			`basePath "${opts.basePath}" does not match redirectUri "${client.redirectUri}": the callback is served at "${explicit}${CALLBACK_SUFFIX}" but redirectUri points at "${redirectPath}". Drop basePath to derive it from redirectUri.`,
		);
	}
	return explicit;
}

/**
 * Serves the sign-in routes `GET {basePath}/login`, `/callback` and `/logout` for an
 * {@link OAuthClient}; use it to build your own adapter or a plain fetch handler.
 *
 * The built-in adapters (`honoOAuthClient`, `expressOAuthClient`, `createRouteHandlers`,
 * `nodeOAuthClient`) already call it. The routes answer 302 on success, 400 for a bad callback and
 * 503 when the authorization server is unavailable (500 for anything unexpected); they never throw.
 *
 * @param client The client from `createOAuth(...).client`.
 * @param request The incoming request; its method, URL and `Cookie` header are read.
 * @param opts See {@link OAuthRouteOptions}.
 * @returns The route's `Response`, or `undefined` for any other request so the caller keeps routing.
 * @throws {OAuthConfigError} If the `redirectUri` path does not end in `/callback`, or an explicit
 *   `basePath` disagrees with it. Call {@link resolveBasePath} at startup to fail early.
 * @see {@link authenticate} to guard API routes.
 *
 * @example
 * ```ts
 * import { createOAuth } from "@neon/oauth";
 * import { routeOAuthClient } from "@neon/oauth/adapter";
 *
 * const oauth = createOAuth({
 *   baseUrl: process.env.NEON_AUTH_BASE_URL!,
 *   clientId: process.env.NEON_AUTH_CLIENT_ID!,
 *   redirectUri: "https://app.example.com/api/auth/callback",
 *   cookies: { secret: process.env.NEON_AUTH_COOKIE_SECRET! },
 * });
 *
 * export default {
 *   async fetch(request: Request) {
 *     return (await routeOAuthClient(oauth.client, request)) ?? new Response("Not found", { status: 404 });
 *   },
 * };
 * ```
 */
export async function routeOAuthClient(
	client: OAuthClient,
	request: Request,
	opts: OAuthRouteOptions = {},
): Promise<Response | undefined> {
	const prefix = resolveBasePath(client, opts);
	if (request.method !== "GET") return undefined;
	const { pathname } = new URL(request.url);
	if (!pathname.startsWith(`${prefix}/`)) return undefined;
	const action = pathname.slice(prefix.length + 1);
	if (action === "login" || action === "callback" || action === "logout") {
		return client.handlers[action](request);
	}
	return undefined;
}

/**
 * Returns the Client ID Metadata Document as a JSON `Response` with `cache-control: public, max-age=3600`.
 * Use it where you already route by path, as `createClientMetadataHandlers` does; otherwise use
 * {@link routeClientMetadata}.
 */
export function clientMetadataResponse(doc: ClientMetadataDocument): Response {
	return new Response(JSON.stringify(doc), {
		headers: {
			"content-type": "application/json",
			"cache-control": "public, max-age=3600",
		},
	});
}

/**
 * Serves a Client ID Metadata Document at the path of its `client_id`; use it to build your own
 * adapter. The built-in adapters (`honoClientMetadata`, `expressClientMetadata`,
 * `nodeClientMetadata`) already call it.
 *
 * @param doc The result of `createClientMetadataDocument`.
 * @param request The incoming request; only its method and URL path are read.
 * @returns The document as JSON for GET and HEAD on the `client_id` path, or `undefined` for any
 *   other request so the caller keeps routing.
 */
export function routeClientMetadata(
	doc: ClientMetadataDocument,
	request: Request,
): Response | undefined {
	if (request.method !== "GET" && request.method !== "HEAD") return undefined;
	if (new URL(request.url).pathname !== new URL(doc.client_id).pathname) {
		return undefined;
	}
	return clientMetadataResponse(doc);
}
