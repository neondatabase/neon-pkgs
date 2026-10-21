/**
 * `@neon/oauth` — use Neon Auth as the OAuth provider: sign users in, verify the access tokens it
 * issues, and protect MCP servers.
 *
 * Start with {@link createOAuth}. An API that only accepts tokens can use `createVerifier` from
 * `@neon/oauth/verify`, and an MCP server `createMcpAuth` from `@neon/oauth/mcp`; both skip
 * loading the sign-in client.
 *
 * **Stability: beta.** Minor versions may include breaking changes.
 *
 * @module
 */

import type { OAuthClient, OAuthClientConfig } from "./client";
import { createOAuthClient } from "./client";
import type { McpAuth, McpOptions } from "./mcp/resource-server";
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
	OAuthClientConfig,
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
	McpAuth,
	McpOptions,
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

/**
 * Options for {@link createOAuth} when you only verify tokens or protect MCP servers.
 * The sign-in client settings are rejected at compile time, so `client` is never half-configured.
 */
export type OAuthWithoutClientOptions = OAuthCommonOptions & {
	[K in keyof OAuthClientConfig]?: never;
};

/** Options for {@link createOAuth} when the app also signs users in: the verification options plus {@link OAuthClientConfig}. The result exposes `client`. */
export type OAuthWithClientOptions = OAuthCommonOptions & OAuthClientConfig;

/** Everything {@link createOAuth} accepts: {@link OAuthWithClientOptions} or {@link OAuthWithoutClientOptions}. */
export type OAuthOptions = OAuthWithoutClientOptions | OAuthWithClientOptions;

/**
 * A per-issuer instance returned by {@link createOAuth}.
 *
 * Token verification, bearer guards, MCP servers and the sign-in client it hands out share one
 * discovery cache and one signing-key cache.
 */
export interface OAuth {
	/** The issuer: `baseUrl` without a trailing slash. */
	readonly issuer: string;
	/**
	 * Returns the authorization server's metadata (`jwks_uri`, endpoints, ...), cached for
	 * `discovery.ttlMs`. Concurrent callers share one fetch.
	 *
	 * @returns The discovery document.
	 * @throws {AuthServerUnavailableError} If the server cannot be reached or its document is
	 *   untrusted (issuer mismatch, no `jwks_uri`).
	 */
	getDiscovery(): Promise<AuthServerMetadata>;
	/**
	 * Verifies a raw access token's signature, issuer, expiry and audience. Use it when you read
	 * the `Authorization` header yourself; the lowest-level check.
	 *
	 * @param token The bearer token, without the `Bearer ` prefix.
	 * @param options.audience The API identifier the token must have been issued for (its `aud`).
	 * @returns `{ ok: true, auth }`, or `{ ok: false, reason: "invalid_token", code, message }` for a bad token.
	 * @throws {AuthServerUnavailableError} If the discovery document or signing keys cannot be fetched, or
	 *   verification fails for a reason other than the token itself.
	 */
	verifyAccessToken(
		token: string,
		options: { audience: string },
	): Promise<VerifyResult>;
	/**
	 * Creates a framework-neutral {@link BearerGuard} for a generic API. The framework guards
	 * (`honoBearerAuth`, `expressBearerAuth`, `withAuth`, ...) are built on it.
	 *
	 * @param options Audience, required scopes and `onError`. See {@link OAuthBearerOptions}.
	 * @returns A guard that never throws.
	 * @throws {OAuthConfigError} If neither `options.audience` nor the configured `resource` is set.
	 */
	requireBearerAuth(options?: OAuthBearerOptions): BearerGuard;
	/**
	 * Creates the authentication helper for an MCP server, sharing this instance's caches. It does
	 * not create an MCP server; pass the result to an MCP adapter such as `honoMcp`.
	 *
	 * Use it when the same app also signs users in or guards other APIs; otherwise `createMcpAuth`
	 * from `@neon/oauth/mcp` is equivalent and lighter.
	 *
	 * @param options The MCP `resource` and optional `scopesSupported`. See {@link McpOptions}.
	 * @returns An {@link McpAuth}.
	 * @throws {OAuthConfigError} If `options.resource` is not an absolute URL.
	 */
	mcp(options: McpOptions): McpAuth;
}

/** The {@link OAuth} instance {@link createOAuth} returns when the sign-in client settings are given. */
export interface OAuthWithClient extends OAuth {
	/** The client for signing users in. Mount its routes with a framework adapter, then read the session with `getUser` / `getSession`. */
	readonly client: OAuthClient;
}

/**
 * Creates the {@link OAuth} instance for one Neon Auth issuer: token verification, bearer guards,
 * MCP helpers and, when the sign-in settings are given, the sign-in `client`.
 *
 * Use it when one app does several of those things, and create one instance per issuer. Everything
 * it hands out shares one discovery cache and one signing-key cache. Nothing is read from the
 * environment and nothing is fetched until first use, so the app boots while Neon Auth is
 * unreachable; operations that need the server then throw `AuthServerUnavailableError`.
 *
 * @param options Verification options, plus the sign-in settings (`clientId`, `redirectUri`,
 *   `cookies`, ...) to get `client`. See {@link OAuthWithClientOptions}.
 * @returns An {@link OAuthWithClient} when `clientId`, `redirectUri` and `cookies` are given,
 *   otherwise an {@link OAuth}.
 * @throws {OAuthConfigError} If `baseUrl` is missing or not an absolute URL; the sign-in settings
 *   are partial (the message names what is missing), `redirectUri` is not an absolute URL,
 *   `cookies.secret` is shorter than 32 characters, or a URL `clientId` is combined with a `clientSecret`.
 * @see `createVerifier` from `@neon/oauth/verify` for an API that only accepts tokens.
 * @see `createMcpAuth` from `@neon/oauth/mcp` for an MCP server.
 *
 * @example
 * ```ts
 * import { Hono } from "hono";
 * import { createOAuth } from "@neon/oauth";
 * import { honoBearerAuth, honoOAuthClient, type AuthVariables } from "@neon/oauth/hono";
 *
 * const oauth = createOAuth({
 *   baseUrl: process.env.NEON_AUTH_BASE_URL!,
 *   resource: "https://api.example.com",
 *   clientId: process.env.NEON_AUTH_CLIENT_ID!,
 *   redirectUri: "https://app.example.com/api/auth/callback",
 *   cookies: { secret: process.env.NEON_AUTH_COOKIE_SECRET! },
 * });
 *
 * const app = new Hono<AuthVariables>();
 * app.use(honoOAuthClient(oauth.client)); // /api/auth/login, /callback, /logout
 * app.get("/me", async (c) => { // browser session
 *   const result = await oauth.client.getUser(c.req.raw);
 *   return result.ok ? c.json(result.user) : c.json({ error: result.reason }, 401);
 * });
 * app.get("/api/things", honoBearerAuth(oauth), (c) => c.json({ user: c.get("auth").sub })); // bearer token
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
