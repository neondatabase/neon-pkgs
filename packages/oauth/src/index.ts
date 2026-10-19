/**
 * `@neon/oauth` — sign users in to your app with Neon Auth as the OAuth provider, and verify
 * the bearer tokens it issues.
 *
 * **Stability: beta.** Minor versions may include breaking changes.
 *
 * @module
 */

import type { CookieOptions, OAuthClient } from "./client";
import { createOAuthClient } from "./client";
import type { McpOptions, McpResourceServer } from "./mcp/resource-server";
import { createMcp } from "./mcp/resource-server";
import type { BearerGuard, OAuthBearerOptions } from "./verify/bearer";
import type {
	AuthServerMetadata,
	VerifierOptions,
	VerifyResult,
} from "./verify/verifier";
import { createVerifier } from "./verify/verifier";

export type {
	AccessTokenContext,
	AccessTokenFailure,
	AccessTokenResult,
	AuthUser,
	CookieOptions,
	LoginAttempt,
	LoginResult,
	OAuthClient,
	Session,
	SessionFailure,
	SessionResult,
	UserResult,
} from "./client";
export type {
	ClientMetadataDocument,
	ClientMetadataDocumentOptions,
} from "./client/metadata-document";
export { createClientMetadataDocument } from "./client/metadata-document";
export type {
	McpOptions,
	McpResourceServer,
} from "./mcp/resource-server";
export type {
	BearerAuthOptions,
	BearerGuard,
	OAuthBearerOptions,
} from "./verify/bearer";
export type { InvalidTokenCode } from "./verify/errors";
export {
	AuthServerUnavailableError,
	InvalidTokenError,
	OAuthConfigError,
	OAuthError,
} from "./verify/errors";
export type {
	AuthResult,
	AuthServerMetadata,
	VerifyResult,
} from "./verify/verifier";

type OAuthCommonOptions = VerifierOptions;

/** The sign-in client's settings. All of `clientId`, `redirectUri` and `cookies` are required together. */
export interface OAuthClientConfig {
	/** A pre-registered client id, or the https URL of a Client ID Metadata Document (see `createClientMetadataDocument`). */
	clientId: string;
	/** Omit for a public client (PKCE only). Not allowed with a URL `clientId`. */
	clientSecret?: string;
	/** Must equal a redirect URI registered on the client. Its path must end in `/callback`; adapters serve the sign-in routes from the path's prefix. */
	redirectUri: string;
	/** Scopes to request. Defaults to `["profile", "email"]`; `openid` is always added because sign-in needs the ID token. */
	scopes?: string[];
	/** How the encrypted session cookie is named, scoped and keyed. */
	cookies: CookieOptions;
	/**
	 * Called with the cause when a sign-in route answers 5xx (authorization server unavailable),
	 * for logging. Expected failures (a denied or forged callback) are not reported.
	 */
	onError?: (error: unknown, request: Request) => void;
}

/**
 * Options for `createOAuth` when you only verify tokens and/or protect MCP servers. Sign-in client
 * settings are rejected at compile time so `client` is never half-configured.
 */
export type OAuthWithoutClientOptions = OAuthCommonOptions & {
	[K in keyof OAuthClientConfig]?: never;
};

/** Options for `createOAuth` when the app also signs users in: the verification options plus the sign-in client settings, exposed as `oauth.client`. */
export type OAuthWithClientOptions = OAuthCommonOptions & OAuthClientConfig;

/** Everything `createOAuth` accepts: `OAuthWithClientOptions` or `OAuthWithoutClientOptions`. */
export type OAuthOptions = OAuthWithoutClientOptions | OAuthWithClientOptions;

/**
 * A per-issuer instance returned by `createOAuth`. Everything it hands out (token verification,
 * bearer guards, MCP servers and the sign-in client) shares one discovery cache and one JWKS cache.
 */
export interface OAuth {
	/** `baseUrl` without a trailing slash. */
	readonly issuer: string;
	/**
	 * The authorization server's metadata (`jwks_uri`, endpoints, ...), cached for `discovery.ttlMs`.
	 * Concurrent callers share one fetch. Throws `AuthServerUnavailableError` when the server cannot
	 * be reached or its document is untrusted (wrong `issuer`, no `jwks_uri`).
	 */
	getDiscovery(): Promise<AuthServerMetadata>;
	/**
	 * Verifies a raw access token's signature, issuer, expiry and `audience`; the lowest-level check,
	 * for when you handle the `Authorization` header yourself. A bad token is `{ ok: false, reason: "invalid_token", code }`;
	 * an unreachable authorization server throws `AuthServerUnavailableError`.
	 * @param token The bearer token, without the `Bearer ` prefix.
	 * @param options.audience The API identifier the token must have been issued for (its `aud`).
	 */
	verifyAccessToken(
		token: string,
		options: { audience: string },
	): Promise<VerifyResult>;
	/**
	 * Builds a framework-neutral guard for a generic API: given a `Request` it resolves to the verified
	 * `AuthResult`, or a ready 401/403/503 `Response`. The guard never throws. Framework adapters
	 * (`honoBearerAuth`, `expressBearerAuth`, `withAuth`, ...) are built on it.
	 * Creating it throws `OAuthConfigError` when neither `options.audience` nor the configured `resource` is set.
	 */
	requireBearerAuth(options?: OAuthBearerOptions): BearerGuard;
	/**
	 * Creates the authentication helper for an MCP server (token verification bound to the MCP
	 * `resource`, plus the protected-resource metadata), sharing this instance's caches. It does not
	 * create an MCP server. Pass the result to an MCP adapter such as `honoMcp`.
	 * Use this when the same app also signs users in or guards other APIs; otherwise `createMcpAuth`
	 * from `@neon/oauth/mcp` is equivalent and lighter. Throws `OAuthConfigError` when `resource` is not an absolute URL.
	 */
	mcp(options: McpOptions): McpResourceServer;
}

/** The `OAuth` instance `createOAuth` returns when the sign-in client settings are given. */
export interface OAuthWithClient extends OAuth {
	/** The OAuth client for signing users in: mount its routes with a framework adapter and read the session with `getUser` / `getSession`. */
	readonly client: OAuthClient;
}

/**
 * The single entry point of `@neon/oauth`: creates the instance for one Neon Auth issuer.
 *
 * The returned object has `issuer`, `getDiscovery()`, `verifyAccessToken()`, `requireBearerAuth()`,
 * `mcp()` and, when `clientId`, `redirectUri` and `cookies` are given, `client` for signing users in.
 * All of them share one discovery cache and one JWKS cache, so create one instance per issuer
 * and reuse it. Nothing is read from the environment.
 *
 * Use it when one app does several of those things. An API that only accepts tokens can use
 * `createVerifier` from `@neon/oauth/verify`, and an MCP server `createMcpAuth` from
 * `@neon/oauth/mcp`; both skip loading the sign-in client (`openid-client`).
 *
 * Throws `OAuthConfigError` at creation for a missing or non-absolute `baseUrl`, a partial client
 * configuration (naming what is missing), a short `cookies.secret`, or a URL `clientId` combined
 * with a `clientSecret`. Nothing is fetched until first use, so the app boots while Neon Auth is
 * unreachable; operations that need the server then throw `AuthServerUnavailableError`.
 *
 * @example
 * ```ts
 * const oauth = createOAuth({
 *   baseUrl: process.env.NEON_AUTH_BASE_URL!,
 *   resource: "https://api.example.com",
 *   clientId: process.env.CLIENT_ID!,
 *   redirectUri: "https://app.example.com/api/auth/callback",
 *   cookies: { secret: process.env.COOKIE_SECRET! },
 * });
 * app.use(honoOAuthClient(oauth.client));
 * app.use("/api/*", honoBearerAuth(oauth));
 * ```
 */
export function createOAuth(options: OAuthWithClientOptions): OAuthWithClient;
export function createOAuth(options: OAuthWithoutClientOptions): OAuth;
export function createOAuth(options: OAuthOptions): OAuth | OAuthWithClient {
	const verifier = createVerifier(options);
	const { resource } = options;

	const oauth: OAuth = {
		issuer: verifier.issuer,
		getDiscovery: verifier.getDiscovery,
		verifyAccessToken: (token, { audience }) =>
			verifier.verifyAccessToken(token, audience),
		requireBearerAuth: verifier.requireBearerAuth,
		mcp: (mcpOptions) => createMcp(verifier, mcpOptions),
	};

	const hasClientSettings = CLIENT_KEYS.some(
		(key) => key in options && options[key] !== undefined,
	);
	if (!hasClientSettings) return oauth;
	return {
		...oauth,
		client: createOAuthClient(
			{
				clientId: options.clientId,
				clientSecret: options.clientSecret,
				redirectUri: options.redirectUri,
				resource,
				scopes: options.scopes,
				cookies: options.cookies,
				onError: options.onError,
			},
			verifier.getDiscovery,
		),
	};
}

const CLIENT_KEYS = [
	"clientId",
	"clientSecret",
	"redirectUri",
	"scopes",
	"cookies",
] as const;
