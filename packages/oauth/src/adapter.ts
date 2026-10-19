/**
 * `@neon/oauth/adapter` — the contract every OAuth framework adapter is built on. Both
 * functions speak Web `Request`/`Response`; an adapter only converts its framework's
 * request/response to and from these. Adapters must not reimplement routing or challenges.
 *
 * @module
 */

import type { OAuthClient } from "./client";
import type { ClientMetadataDocument } from "./client/metadata-document";
import type { OAuth } from "./index";
import type { McpResourceServer } from "./mcp/resource-server";
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
 * `authenticate`) need from their first argument: satisfied by `createOAuth()` and by
 * `createVerifier()` from `@neon/oauth/verify`, so an API-only server does not load the sign-in client.
 */
export type AuthSource = BearerSource<OAuthBearerOptions>;

export type {
	AuthOutcome,
	AuthResult,
	ClientMetadataDocument,
	McpResourceServer,
	OAuth,
	OAuthBearerOptions,
	OAuthClient,
};

/**
 * Checks the bearer token of a Web `Request` and returns `{ ok: true, auth }` with the verified
 * `AuthResult`, or `{ ok: false, response }` with a ready 401 (missing or invalid token), 403
 * (missing scope) or 503 (authorization server unavailable) `Response` to send as-is. It never throws
 * for those outcomes; a throwing `opts.onError` is swallowed.
 *
 * Use it in a custom adapter or handler (a framework this package has no adapter for, a plain
 * fetch handler) that needs to guard a route itself. Prefer the framework guards
 * (`honoBearerAuth`, `expressBearerAuth`, `withAuth`, `nodeBearerAuth`, `honoMcp`, ...) when one
 * exists: they call this and wire the result into the framework.
 *
 * @param source A `createOAuth()` instance or `createVerifier()` verifier (`opts.audience` is
 *   then required unless a `resource` was configured, otherwise `OAuthConfigError` is thrown), or the
 *   result of `createMcpAuth()` (audience and `resource_metadata` challenge come from it).
 * @param request Only the `Authorization` header is read.
 *
 * @example
 * ```ts
 * import { authenticate } from "@neon/oauth/adapter";
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
	source: McpResourceServer,
	request: Request,
	opts?: BearerAuthOptions,
): Promise<AuthOutcome>;
export function authenticate(
	source: AuthSource,
	request: Request,
	opts?: OAuthBearerOptions,
): Promise<AuthOutcome>;
export function authenticate(
	source: McpResourceServer | AuthSource,
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
	 * Path prefix for `/login`, `/callback` and `/logout`. Defaults to the prefix of the client's
	 * `redirectUri` path (`https://app.test/api/auth/callback` serves `/api/auth/*`), so the
	 * callback route and the registered redirect cannot drift apart. When given, it must equal
	 * that prefix; `''` serves the routes at the root.
	 */
	basePath?: string;
}

const CALLBACK_SUFFIX = "/callback";

/**
 * The route prefix for `client`, derived from its `redirectUri`. Throws when `redirectUri` does not
 * end in `/callback`, or when an explicit `basePath` disagrees with it.
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
 * Serves the sign-in routes `GET ${basePath}/login`, `/callback` and `/logout` for an `OAuthClient`
 * and resolves to their `Response`; resolves to `undefined` for any other request so the caller
 * keeps routing. `basePath` is derived from the client's `redirectUri` (see `OAuthRouteOptions`).
 *
 * Use it to build your own framework adapter, or a plain fetch handler, that mounts the sign-in
 * routes. The built-in adapters (`honoOAuthClient`, `expressOAuthClient`, `createRouteHandlers`,
 * `nodeOAuthClient`) already call it, so you do not need it with those. The routes themselves
 * answer 302 on success, 400 for a bad callback and 503 when the authorization server is
 * unavailable; they never throw. It does throw `OAuthConfigError` when `redirectUri` does not end
 * in `/callback` or an explicit `basePath` disagrees with it, so call `resolveBasePath` once at
 * startup to fail early.
 *
 * @example
 * ```ts
 * import { routeOAuthClient } from "@neon/oauth/adapter";
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
 * The Client ID Metadata Document as a JSON `Response` (`cache-control: public, max-age=3600`;
 * authorization servers cache it for as long as that allows). For frameworks where you already
 * route by path, as in `createClientMetadataHandlers`; otherwise use `routeClientMetadata`.
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
 * Answers GET/HEAD on the path of the document's `client_id` with the document; returns `undefined`
 * for anything else so the caller keeps routing. Use it to build a framework adapter that serves a
 * `createClientMetadataDocument` result; the built-in adapters (`honoClientMetadata`,
 * `expressClientMetadata`, `nodeClientMetadata`) already call it.
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
