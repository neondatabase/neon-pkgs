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
 * What the API guards need from their first argument: satisfied by `createOAuth()` and by
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

/** Verifies the request's bearer token. On failure `response` is a ready 401/403/503 to send as-is. */
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

/** Handles GET `${basePath}/login|callback|logout`; `undefined` for anything else so the caller keeps routing. */
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

/** The document as JSON. Authorization servers cache it for as long as `cache-control` allows. */
export function clientMetadataResponse(doc: ClientMetadataDocument): Response {
	return new Response(JSON.stringify(doc), {
		headers: {
			"content-type": "application/json",
			"cache-control": "public, max-age=3600",
		},
	});
}

/** Answers GET/HEAD on the path of the document's `client_id`; `undefined` for anything else so the caller keeps routing. */
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
