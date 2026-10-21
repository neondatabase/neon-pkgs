// Client side of Neon Auth: sign users in (authorization code + PKCE) and keep the session in an encrypted cookie.
import { decodeJwt } from "jose";
import * as oidc from "openid-client";
import { report } from "../verify/bearer";
import { AuthServerUnavailableError, OAuthConfigError } from "../verify/errors";
import type { AuthServerMetadata } from "../verify/verifier";
import type { SameSite } from "./cookies";
import {
	COOKIE_SIZE_WARN_BYTES,
	deriveKey,
	parseCookies,
	seal,
	serializeCookie,
	unseal,
	unsealResult,
} from "./cookies";
import { isMetadataDocumentClientId } from "./metadata-document";

/**
 * Sign-in client settings for `createOAuth`. Passing `clientId`, `redirectUri` and `cookies`
 * together turns on `oauth.client`; a partial set throws `OAuthConfigError`.
 */
export interface OAuthClientConfig {
	/**
	 * The OAuth client identifier: either a pre-registered client id, or the https URL of a Client
	 * ID Metadata Document, which is sent as-is and fetched by the authorization server. Build and
	 * serve that document with `createClientMetadataDocument`.
	 */
	clientId: string;
	/**
	 * The secret of a confidential client, sent with HTTP Basic authentication at the token
	 * endpoint. Omit it for a public client, which authenticates with PKCE only. Not allowed with a
	 * URL `clientId`.
	 *
	 * @defaultValue omitted: a public client
	 */
	clientSecret?: string;
	/**
	 * Where the authorization server sends the browser after sign-in, e.g.
	 * `"https://app.example.com/api/auth/callback"`. Must exactly match a redirect URI registered
	 * for the client. The framework adapters require its path to end in `/callback` and mount
	 * `login`, `callback` and `logout` under the preceding prefix (`/api/auth` here).
	 */
	redirectUri: string;
	/**
	 * Scopes to request. `openid` is always added, because sign-in needs the ID token. `email`
	 * fills `AuthUser.email` and `emailVerified`; `profile` fills `name` and `image`.
	 *
	 * @defaultValue `["profile", "email"]`
	 */
	scopes?: string[];
	/** How the encrypted session cookie is named, scoped and keyed. See {@link CookieOptions}. */
	cookies: CookieOptions;
	/**
	 * Called with the cause when a sign-in route answers 5xx (authorization server unavailable or
	 * an unexpected failure), for logging. Expected failures such as a denied or forged callback
	 * are not reported. A throwing callback is ignored.
	 */
	onError?: (error: unknown, request: Request) => void;
}

/** What `createOAuthClient` takes: {@link OAuthClientConfig} plus `resource`, which `createOAuth` passes from its verification options. */
export type OAuthClientOptions = OAuthClientConfig & {
	/** The API the access token is for; sent as `resource` on authorize and token requests, and becomes the token's `aud`. */
	resource?: string;
};

/** How the client's encrypted, stateless session cookie is keyed, named and scoped. */
export interface CookieOptions {
	/** Encrypts the cookies; at least 32 characters (try `openssl rand -hex 32`). Changing it signs everyone out. */
	secret: string;
	/**
	 * Session cookie name. The login-transaction cookie is named `<name>_tx`.
	 *
	 * @defaultValue `"neon_auth_session"`
	 */
	name?: string;
	/**
	 * Session lifetime in seconds.
	 *
	 * @defaultValue `604800` (7 days)
	 */
	maxAgeSeconds?: number;
	/**
	 * Cookie `Domain`, to share the session across subdomains. Applies to the session cookie only.
	 *
	 * @defaultValue omitted: the cookie is host-only
	 */
	domain?: string;
	/**
	 * Cookie `SameSite` attribute of the session cookie. The login-transaction cookie is always Lax,
	 * so the redirect back to the callback carries it. `"none"` forces `Secure`.
	 *
	 * @defaultValue `"lax"`
	 */
	sameSite?: SameSite;
}

/**
 * The signed-in user. `id` is the `sub` of the verified ID token; the rest comes from the userinfo
 * endpoint. A field the server did not return is absent, never an empty string.
 */
export interface AuthUser {
	/** The `sub` of the verified ID token. */
	id: string;
	/** Present when the `email` scope was granted and the user has an email. */
	email?: string;
	/** Whether the server verified `email`. */
	emailVerified?: boolean;
	/** Present when the `profile` scope was granted and the user has a name. */
	name?: string;
	/** URL of the user's picture. Present when the `profile` scope was granted and the user has one. */
	image?: string;
}

/** What the session cookie holds. */
export interface Session {
	/** The access token to call your API with. */
	accessToken: string;
	/** Present when the server issued one; without it an expired access token cannot be refreshed. */
	refreshToken?: string;
	/** Access-token expiry, in seconds since the epoch. */
	expiresAt?: number;
	/** The signed-in user. */
	user: AuthUser;
}

/** The values `startLogin` generates and `finishLogin` needs back. Keep them (server-side or in a short-lived cookie) until the callback. */
export interface LoginAttempt {
	/** Anti-CSRF value; the callback's `state` must equal it. */
	state: string;
	/** The PKCE verifier matching the challenge sent on the authorize URL. */
	codeVerifier: string;
}

/**
 * Why there is no session.
 *
 * - `no_session`: no session cookie; the user must sign in.
 * - `invalid_session`: the cookie is not sealed with this app's secret (tampered, or the secret was rotated).
 * - `expired`: the cookie outlived `cookies.maxAgeSeconds`.
 */
export type SessionFailure = {
	ok: false;
	reason: "no_session" | "invalid_session" | "expired";
};
/** Outcome of `getSession`: the `session`, or why there is none. */
export type SessionResult = { ok: true; session: Session } | SessionFailure;
/** Outcome of `getUser`: the signed-in `user`, or why there is none. */
export type UserResult = { ok: true; user: AuthUser } | SessionFailure;

/**
 * Outcome of completing a sign-in: the `session`, or why it failed.
 *
 * - `invalid_callback`: the callback carries an error, no code, or a `state` that does not match the attempt.
 * - `token_rejected`: the token endpoint refused the code, or answered without an ID token.
 * - `userinfo_rejected`: the userinfo endpoint answered with a 4xx or an unusable body, or its `sub` differs from the ID token's.
 *
 * An unreachable token or userinfo endpoint (network error, timeout, 5xx) throws `AuthServerUnavailableError` instead.
 */
export type LoginResult =
	| { ok: true; session: Session }
	| {
			ok: false;
			reason: "invalid_callback" | "token_rejected" | "userinfo_rejected";
	  };

/** Why no access token could be produced. */
export type AccessTokenFailure = {
	ok: false;
	/**
	 * - `no_session`: no readable session cookie; the user must sign in.
	 * - `refresh_unavailable`: the token expired and the session has no refresh token.
	 * - `refresh_failed`: the token endpoint rejected the refresh (revoked or already-used refresh token).
	 *
	 * An unreachable token endpoint throws `AuthServerUnavailableError` instead.
	 */
	reason: "no_session" | "refresh_unavailable" | "refresh_failed";
};

/** Outcome of `getAccessToken`: the token, or why there is none. */
export type AccessTokenResult =
	| {
			ok: true;
			/** A current access token. */
			accessToken: string;
			/** Present when the token was refreshed: append it to your response as `Set-Cookie`. */
			setCookie?: string;
	  }
	| AccessTokenFailure;

/** What `withAccessToken` hands to its callback. */
export interface AccessTokenContext {
	/** A current access token. */
	accessToken: string;
	/** `{ authorization: "Bearer <token>" }`, to spread into the outgoing request's headers. */
	authorizationHeaders: { authorization: string };
}

/**
 * The sign-in client of a `createOAuth` instance (`oauth.client`): authorization code with
 * PKCE, and the session kept in an encrypted cookie with no server-side store.
 *
 * Mount `handlers` with a framework adapter (`honoOAuthClient`, `expressOAuthClient`,
 * `createRouteHandlers`, `nodeOAuthClient`), then read the signed-in user with `getUser(request)`.
 */
export interface OAuthClient {
	/**
	 * Request handlers for the sign-in routes. Mount them through a framework adapter (or
	 * `routeOAuthClient`) rather than calling them directly. None throws: an outage answers 503 and
	 * anything unexpected 500, with the cause reported to `onError`.
	 */
	readonly handlers: {
		/** Redirects (302) to the authorization server. `?returnTo=/path` (same-site paths only; default `/`) is where the user lands afterwards. */
		login(request: Request): Promise<Response>;
		/** Completes sign-in, sets the session cookie and redirects (302) to `returnTo`. Answers 400 for a bad or expired attempt. */
		callback(request: Request): Promise<Response>;
		/** Clears this app's session cookie and redirects (302) to `returnTo`. It does not end the Neon Auth session. */
		logout(request: Request): Promise<Response>;
	};
	/** The configured redirect URI; adapters derive the callback route from its path. */
	readonly redirectUri: string;
	/**
	 * Reads the session, including tokens, from the request's cookie. Never contacts the server.
	 *
	 * @param request The incoming request; only its `Cookie` header is read.
	 * @returns `{ ok: true, session }`, or `{ ok: false, reason }` for a missing, tampered or expired cookie.
	 */
	getSession(request: Request): Promise<SessionResult>;
	/**
	 * Reads the signed-in user from the request's session cookie. Never contacts the server.
	 *
	 * @param request The incoming request; only its `Cookie` header is read.
	 * @returns `{ ok: true, user }`, or `{ ok: false, reason }` with the same reasons as {@link OAuthClient.getSession}.
	 */
	getUser(request: Request): Promise<UserResult>;
	/**
	 * Returns a usable access token for this request, refreshing it first if it expires within 30 seconds.
	 *
	 * Concurrent refreshes of the same refresh token on this client instance share one token request.
	 * Separate instances and processes do not coordinate, so a rotating refresh token can still be spent twice
	 * across instances. Prefer {@link OAuthClient.withAccessToken}, which also handles the refreshed cookie.
	 *
	 * @param request The incoming request; only its `Cookie` header is read.
	 * @returns `{ ok: true, accessToken, setCookie? }`, where a present `setCookie` must be appended
	 *   to your response as `Set-Cookie`; or `{ ok: false, reason }`.
	 * @throws {AuthServerUnavailableError} If a needed refresh cannot reach the server.
	 * @throws {OAuthConfigError} If the client uses a URL `clientId` and the server does not support Client ID Metadata Documents.
	 */
	getAccessToken(request: Request): Promise<AccessTokenResult>;
	/**
	 * Runs `fn` with a current access token and appends the refreshed session cookie, if any, to
	 * the `Response` it returns (existing `Set-Cookie` headers are kept).
	 *
	 * @param request The incoming request; only its `Cookie` header is read.
	 * @param fn Receives the access token and ready-made `Authorization` headers; returns the `Response` to send.
	 * @returns `{ ok: true, response }`, or `{ ok: false, reason }` when there is no usable token.
	 * @throws {AuthServerUnavailableError} If a needed refresh cannot reach the server.
	 * @throws {OAuthConfigError} If the client uses a URL `clientId` and the server does not support Client ID Metadata Documents.
	 */
	withAccessToken(
		request: Request,
		fn: (context: AccessTokenContext) => Response | Promise<Response>,
	): Promise<{ ok: true; response: Response } | AccessTokenFailure>;
	/**
	 * Advanced: starts a custom sign-in flow instead of using `handlers`.
	 *
	 * @returns The authorize `url` to redirect the browser to, plus the {@link LoginAttempt} values to keep until the callback.
	 * @throws {AuthServerUnavailableError} If the authorization server cannot be reached.
	 * @throws {OAuthConfigError} If the client uses a URL `clientId` and the server does not support Client ID Metadata Documents.
	 */
	startLogin(): Promise<LoginAttempt & { url: URL }>;
	/**
	 * Advanced: completes a custom sign-in flow started with {@link OAuthClient.startLogin}. It
	 * checks `state`, exchanges the callback's `code` for tokens (sending the PKCE verifier) and loads the user.
	 *
	 * @param callbackUrl The full callback URL the browser was redirected to.
	 * @param attempt The values returned by `startLogin`.
	 * @returns `{ ok: true, session }`, or `{ ok: false, reason }`; see {@link LoginResult}.
	 * @throws {AuthServerUnavailableError} If the token or userinfo endpoint cannot be reached.
	 * @throws {OAuthConfigError} If the client uses a URL `clientId` and the server does not support Client ID Metadata Documents.
	 */
	finishLogin(callbackUrl: URL, attempt: LoginAttempt): Promise<LoginResult>;
}

const TX_MAX_AGE_SECONDS = 600;
const REFRESH_SKEW_SECONDS = 30;

/**
 * Creates the sign-in client. Prefer `createOAuth`, which calls this with its shared discovery
 * cache as `getDiscovery`, so the client never fetches discovery on its own.
 *
 * @throws {OAuthConfigError} If a required setting is missing (the message names each) or invalid.
 */
export function createOAuthClient(
	options: Partial<OAuthClientOptions>,
	getDiscovery: () => Promise<AuthServerMetadata>,
): OAuthClient {
	const missing = [
		!options.clientId && "clientId",
		!options.redirectUri && "redirectUri",
		!options.cookies?.secret && "cookies.secret",
	].filter(Boolean);
	if (missing.length > 0) {
		throw new OAuthConfigError(
			`OAuth client is not configured (missing: ${missing.join(", ")}). Pass them to createOAuth().`,
		);
	}
	const { clientId, clientSecret, redirectUri, resource, onError } =
		options as OAuthClientOptions;
	if (!URL.canParse(redirectUri)) {
		throw new OAuthConfigError(
			`redirectUri must be an absolute URL, got "${redirectUri}".`,
		);
	}
	const usesMetadataDocument = isMetadataDocumentClientId(clientId);
	if (usesMetadataDocument && clientSecret) {
		throw new OAuthConfigError(
			"A URL clientId (Client ID Metadata Document) identifies a public client: remove clientSecret.",
		);
	}
	const cookies = options.cookies as CookieOptions;
	const cookieSecret = cookies.secret;
	// finishLogin needs the ID token, which the server only issues for the openid scope.
	const requested = options.scopes ?? ["profile", "email"];
	const scopes = ["openid", ...requested.filter((s) => s !== "openid")];
	const sessionCookie = cookies.name ?? "neon_auth_session";
	const txCookie = `${sessionCookie}_tx`;
	const sessionMaxAge = cookies.maxAgeSeconds ?? 7 * 86_400;
	const { domain, sameSite } = cookies;

	// Fail at startup, not on the first login.
	deriveKey(cookieSecret, "session");

	const redirect = new URL(redirectUri);
	const localHttp =
		redirect.protocol === "http:" &&
		["localhost", "127.0.0.1", "[::1]"].includes(redirect.hostname);
	const secure = !localHttp;

	// Built from the shared discovery document, and rebuilt when that cache refreshes. Lazy so the app
	// boots before Neon Auth is reachable.
	let configured:
		| { doc: AuthServerMetadata; config: oidc.Configuration }
		| undefined;
	async function getConfiguration(): Promise<oidc.Configuration> {
		const doc = await getDiscovery();
		if (
			usesMetadataDocument &&
			doc.client_id_metadata_document_supported !== true
		) {
			throw new OAuthConfigError(
				`clientId is a URL (Client ID Metadata Document) but ${doc.issuer} does not advertise "client_id_metadata_document_supported". Use a pre-registered clientId, or enable client metadata documents on the authorization server.`,
			);
		}
		if (configured?.doc !== doc) {
			configured = {
				doc,
				config: new oidc.Configuration(
					doc as oidc.ServerMetadata,
					clientId,
					// Neon Auth signs ID tokens with EdDSA; the library default (RS256) would reject them.
					{ id_token_signed_response_alg: "EdDSA" },
					// Neon Auth rejects client_secret_post for confidential clients, so authenticate
					// at the token endpoint with HTTP Basic. Public clients send no secret and rely on PKCE.
					clientSecret
						? oidc.ClientSecretBasic(clientSecret)
						: oidc.None(),
				),
			};
		}
		return configured.config;
	}

	async function startLogin(): Promise<LoginAttempt & { url: URL }> {
		const codeVerifier = oidc.randomPKCECodeVerifier();
		const state = oidc.randomState();
		const url = oidc.buildAuthorizationUrl(await getConfiguration(), {
			redirect_uri: redirectUri,
			scope: scopes.join(" "),
			...(resource && { resource }),
			state,
			code_challenge: await oidc.calculatePKCECodeChallenge(codeVerifier),
			code_challenge_method: "S256",
		});
		return { url, state, codeVerifier };
	}

	/**
	 * The token endpoint refusing a grant (a 4xx OAuth error) is an expected outcome. Anything else —
	 * network failure, 5xx, a malformed response — means the server could not be relied on.
	 */
	function isRejection(err: unknown): boolean {
		return err instanceof oidc.ResponseBodyError && err.status < 500;
	}

	function unavailable(
		err: unknown,
		endpoint = "Token endpoint",
	): AuthServerUnavailableError {
		return err instanceof AuthServerUnavailableError
			? err
			: new AuthServerUnavailableError(`${endpoint} unavailable`, {
					cause: err,
				});
	}

	/**
	 * Userinfo failures that mean the server answered and refused: a 4xx, a body without a usable
	 * `sub`, or a `sub` that differs from the ID token's. The library nests the HTTP response (or
	 * the sub mismatch) several causes deep, so walk the chain.
	 */
	function isUserinfoRejection(err: unknown): boolean {
		for (
			let cur: unknown = err;
			cur instanceof Error || cur instanceof Response;
			cur = (cur as { cause?: unknown }).cause
		) {
			const { status, code } = cur as {
				status?: unknown;
				code?: unknown;
			};
			if (typeof status === "number") return status < 500;
			if (
				code === "OAUTH_JSON_ATTRIBUTE_COMPARISON_FAILED" ||
				code === "OAUTH_INVALID_RESPONSE"
			)
				return true;
		}
		return false;
	}

	async function finishLogin(
		callbackUrl: URL,
		attempt: LoginAttempt,
	): Promise<LoginResult> {
		const params = callbackUrl.searchParams;
		if (
			params.has("error") ||
			!params.get("code") ||
			params.get("state") !== attempt.state
		) {
			return { ok: false, reason: "invalid_callback" };
		}
		const config = await getConfiguration();
		let tokens: Awaited<ReturnType<typeof oidc.authorizationCodeGrant>>;
		try {
			tokens = await oidc.authorizationCodeGrant(
				config,
				callbackUrl,
				// The library verifies an ID token when present; a missing one is mapped to token_rejected below instead of a library error.
				{
					pkceCodeVerifier: attempt.codeVerifier,
					expectedState: attempt.state,
					idTokenExpected: false,
				},
				// Repeated on the token request so the issued token is bound to this API.
				resource ? { resource } : undefined,
			);
		} catch (err) {
			if (isRejection(err))
				return { ok: false, reason: "token_rejected" };
			throw unavailable(err);
		}
		// The ID token is the verified source of the user's identity.
		const idClaims = tokens.claims();
		if (!idClaims) return { ok: false, reason: "token_rejected" };

		let info: Awaited<ReturnType<typeof oidc.fetchUserInfo>>;
		try {
			info = await oidc.fetchUserInfo(
				config,
				tokens.access_token,
				idClaims.sub,
			);
		} catch (err) {
			if (isUserinfoRejection(err))
				return { ok: false, reason: "userinfo_rejected" };
			throw unavailable(err, "Userinfo endpoint");
		}
		return {
			ok: true,
			session: {
				...sessionFromTokens(tokens),
				user: userFrom(idClaims.sub, info),
			},
		};
	}

	function sessionFromTokens(
		tokens: oidc.TokenEndpointResponse & oidc.TokenEndpointResponseHelpers,
	) {
		const expiresIn = tokens.expiresIn();
		return {
			accessToken: tokens.access_token,
			refreshToken: tokens.refresh_token,
			expiresAt:
				expiresIn !== undefined
					? Math.floor(Date.now() / 1000) + expiresIn
					: decodeJwt(tokens.access_token).exp,
		};
	}

	// Neon Auth's ID token has no name/email, so the profile comes from the userinfo endpoint.
	function userFrom(id: string, info: Record<string, unknown>): AuthUser {
		const str = (v: unknown) =>
			typeof v === "string" && v ? v : undefined;
		const user: AuthUser = { id };
		const email = str(info.email);
		if (email !== undefined) user.email = email;
		if (typeof info.email_verified === "boolean")
			user.emailVerified = info.email_verified;
		const name = str(info.name);
		if (name !== undefined) user.name = name;
		const image = str(info.picture);
		if (image !== undefined) user.image = image;
		return user;
	}

	async function sessionSetCookie(session: Session): Promise<string> {
		const value = await seal(
			session,
			cookieSecret,
			"session",
			sessionMaxAge,
		);
		if (value.length > COOKIE_SIZE_WARN_BYTES) {
			console.warn(
				`[@neon/oauth] session cookie is ${value.length} bytes; browsers drop cookies over ~4096. ` +
					"Shrink the tokens or move the session server-side.",
			);
		}
		return serializeCookie(sessionCookie, value, {
			maxAge: sessionMaxAge,
			secure,
			domain,
			sameSite,
		});
	}

	// Attributes must match the ones the cookie was set with, or the browser keeps it.
	const clearSession = () =>
		serializeCookie(sessionCookie, "", {
			maxAge: 0,
			secure,
			domain,
			sameSite,
		});
	const clearTx = () => serializeCookie(txCookie, "", { maxAge: 0, secure });

	async function getSession(request: Request): Promise<SessionResult> {
		const result = await unsealResult<Session>(
			parseCookies(request.headers.get("cookie"))[sessionCookie],
			cookieSecret,
			"session",
		);
		if (result.ok) return { ok: true, session: result.data };
		return {
			ok: false,
			reason:
				result.reason === "missing"
					? "no_session"
					: result.reason === "expired"
						? "expired"
						: "invalid_session",
		};
	}

	async function getUser(request: Request): Promise<UserResult> {
		const result = await getSession(request);
		return result.ok ? { ok: true, user: result.session.user } : result;
	}

	// Keyed by refresh token: a rotating server revokes a token once it is redeemed, so a second
	// concurrent redemption would fail and could persist a revoked token in the cookie.
	const refreshes = new Map<string, Promise<AccessTokenResult>>();

	async function refresh(
		session: Session,
		refreshToken: string,
	): Promise<AccessTokenResult> {
		const config = await getConfiguration();
		let tokens: Awaited<ReturnType<typeof oidc.refreshTokenGrant>>;
		try {
			tokens = await oidc.refreshTokenGrant(
				config,
				refreshToken,
				resource ? { resource } : undefined,
			);
		} catch (err) {
			if (isRejection(err))
				return { ok: false, reason: "refresh_failed" };
			throw unavailable(err);
		}
		const refreshed: Session = {
			...session,
			...sessionFromTokens(tokens),
			// Not every server rotates the refresh token.
			refreshToken: tokens.refresh_token ?? refreshToken,
		};
		return {
			ok: true,
			accessToken: refreshed.accessToken,
			setCookie: await sessionSetCookie(refreshed),
		};
	}

	async function getAccessToken(
		request: Request,
	): Promise<AccessTokenResult> {
		const found = await getSession(request);
		// An expired or unreadable cookie is as good as none: the user must sign in again.
		if (!found.ok) return { ok: false, reason: "no_session" };
		const { session } = found;
		const now = Math.floor(Date.now() / 1000);
		if (
			session.expiresAt === undefined ||
			session.expiresAt - REFRESH_SKEW_SECONDS > now
		) {
			return { ok: true, accessToken: session.accessToken };
		}
		const { refreshToken } = session;
		if (!refreshToken) return { ok: false, reason: "refresh_unavailable" };
		let pending = refreshes.get(refreshToken);
		if (!pending) {
			pending = refresh(session, refreshToken).finally(() =>
				refreshes.delete(refreshToken),
			);
			refreshes.set(refreshToken, pending);
		}
		return pending;
	}

	async function withAccessToken(
		request: Request,
		fn: (context: AccessTokenContext) => Response | Promise<Response>,
	): Promise<{ ok: true; response: Response } | AccessTokenFailure> {
		const token = await getAccessToken(request);
		if (!token.ok) return token;
		const response = await fn({
			accessToken: token.accessToken,
			authorizationHeaders: {
				authorization: `Bearer ${token.accessToken}`,
			},
		});
		if (!token.setCookie) return { ok: true, response };
		// Responses from fetch() and Response.redirect() have immutable headers; copy before appending.
		const withCookie = new Response(response.body, response);
		withCookie.headers.append("set-cookie", token.setCookie);
		return { ok: true, response: withCookie };
	}

	// Only same-site paths. Browsers read `//host` and `/\host` as protocol-relative, so a bare
	// leading-slash check would still let /login?returnTo=//evil.example become an open redirect.
	const safeReturnTo = (v: unknown): string =>
		typeof v === "string" &&
		v.startsWith("/") &&
		!v.startsWith("//") &&
		!v.startsWith("/\\")
			? v
			: "/";

	const text = (status: number, body: string) =>
		new Response(body, {
			status,
			headers: {
				"content-type": "text/plain; charset=utf-8",
				"cache-control": "no-store",
			},
		});

	/** A sign-in route never throws: an outage is a 503 and anything unexpected a 500, both reported to `onError`. */
	function failure(err: unknown, request: Request): Response {
		report(onError, err, request);
		return err instanceof AuthServerUnavailableError
			? text(503, "Sign-in unavailable: authorization server unreachable")
			: text(500, "Sign-in failed");
	}

	const handlers = {
		async login(request: Request): Promise<Response> {
			try {
				return await startLoginRedirect(request);
			} catch (err) {
				return failure(err, request);
			}
		},

		async callback(request: Request): Promise<Response> {
			try {
				return await completeLogin(request);
			} catch (err) {
				return failure(err, request);
			}
		},

		async logout(request: Request): Promise<Response> {
			const returnTo = safeReturnTo(
				new URL(request.url).searchParams.get("returnTo"),
			);
			return new Response(null, {
				status: 302,
				headers: { location: returnTo, "set-cookie": clearSession() },
			});
		},
	};

	async function startLoginRedirect(request: Request): Promise<Response> {
		const returnTo = safeReturnTo(
			new URL(request.url).searchParams.get("returnTo"),
		);
		const { url, state, codeVerifier } = await startLogin();
		const tx = await seal(
			{ state, codeVerifier, returnTo },
			cookieSecret,
			"tx",
			TX_MAX_AGE_SECONDS,
		);
		return new Response(null, {
			status: 302,
			headers: {
				location: url.toString(),
				"set-cookie": serializeCookie(txCookie, tx, {
					maxAge: TX_MAX_AGE_SECONDS,
					secure,
				}),
				"cache-control": "no-store",
			},
		});
	}

	async function completeLogin(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const error = url.searchParams.get("error");
		if (error)
			return text(
				400,
				`${error}: ${url.searchParams.get("error_description") ?? ""}`,
			);

		const tx = await unseal<LoginAttempt & { returnTo: string }>(
			parseCookies(request.headers.get("cookie"))[txCookie],
			cookieSecret,
			"tx",
		);
		if (!tx)
			return text(
				400,
				"Sign-in attempt not found or expired. Start again.",
			);

		// Rebuilt on the configured redirect URI: behind a proxy the request's own origin is not the public one.
		const result = await finishLogin(
			new URL(url.pathname + url.search, redirectUri),
			tx,
		);
		if (!result.ok) return text(400, `Sign-in failed: ${result.reason}`);

		const headers = new Headers({
			location: safeReturnTo(tx.returnTo),
			"cache-control": "no-store",
		});
		headers.append("set-cookie", await sessionSetCookie(result.session));
		headers.append("set-cookie", clearTx());
		return new Response(null, { status: 302, headers });
	}

	return {
		handlers,
		redirectUri,
		getSession,
		getUser,
		getAccessToken,
		withAccessToken,
		startLogin,
		finishLogin,
	};
}
