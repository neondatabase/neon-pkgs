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

export interface OAuthClientOptions {
	/**
	 * A pre-registered client id, or the https URL of a Client ID Metadata Document (see
	 * `createClientMetadataDocument`). A URL is sent as-is: the authorization server fetches the document.
	 */
	clientId: string;
	/** Omit for a public client (PKCE only). Not allowed with a URL `clientId`. */
	clientSecret?: string;
	/** Must equal a redirect URI registered on the client, and be served by `handlers.callback`. */
	redirectUri: string;
	/** The API the access token is for; becomes the token's `aud`. */
	resource?: string;
	scopes?: string[];
	cookies: CookieOptions;
	/** Called with the cause when a sign-in route answers 5xx, for logging. */
	onError?: (error: unknown, request: Request) => void;
}

export interface CookieOptions {
	/** At least 32 characters. Encrypts the cookies; changing it signs everyone out. */
	secret: string;
	/** Session cookie name. Defaults to `neon_auth_session`. */
	name?: string;
	/** Defaults to 7 days. */
	maxAgeSeconds?: number;
	/** Share the session across subdomains. Defaults to host-only. */
	domain?: string;
	/** Session cookie only; the login-transaction cookie is always Lax so the redirect back to the callback carries it. Defaults to `lax`. */
	sameSite?: SameSite;
}

/**
 * The signed-in user. `id` is the `sub` of the verified ID token. The rest comes from the userinfo
 * endpoint, which returns `email` / `emailVerified` for the `email` scope and `name` / `image` for
 * the `profile` scope, and only the values the user has. A field the server did not return is absent.
 */
export interface AuthUser {
	id: string;
	email?: string;
	emailVerified?: boolean;
	name?: string;
	image?: string;
}

export interface Session {
	accessToken: string;
	refreshToken?: string;
	/** Access-token expiry, seconds since epoch. */
	expiresAt?: number;
	user: AuthUser;
}

export interface LoginAttempt {
	state: string;
	codeVerifier: string;
}

/**
 * Why there is no session.
 * - `no_session`: no session cookie; the user must sign in.
 * - `invalid_session`: the cookie is not sealed with this app's secret (tampered, or the secret was rotated).
 * - `expired`: the cookie outlived `cookies.maxAgeSeconds`.
 */
export type SessionFailure = {
	ok: false;
	reason: "no_session" | "invalid_session" | "expired";
};
export type SessionResult = { ok: true; session: Session } | SessionFailure;
export type UserResult = { ok: true; user: AuthUser } | SessionFailure;

/**
 * Outcome of completing a sign-in.
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

export type AccessTokenResult =
	| {
			ok: true;
			accessToken: string;
			/** Present when the token was refreshed: append it to your response as `Set-Cookie`. */
			setCookie?: string;
	  }
	| AccessTokenFailure;

/** What `withAccessToken` hands to its callback. */
export interface AccessTokenContext {
	accessToken: string;
	/** Spread into the outgoing request's headers. */
	authorizationHeaders: { authorization: string };
}

export interface OAuthClient {
	/** Request handlers for sign-in. Mount them through a framework adapter rather than calling them directly. */
	readonly handlers: {
		login(request: Request): Promise<Response>;
		callback(request: Request): Promise<Response>;
		logout(request: Request): Promise<Response>;
	};
	/** The configured redirect URI; adapters derive the callback route from its path. */
	readonly redirectUri: string;
	getSession(request: Request): Promise<SessionResult>;
	getUser(request: Request): Promise<UserResult>;
	/**
	 * A usable access token for this request, refreshed first if it is about to expire.
	 * Concurrent refreshes of the same refresh token inside this process share one token request;
	 * separate processes do not coordinate, so a rotating refresh token can still be spent twice
	 * across instances. Throws `AuthServerUnavailableError` when a needed refresh cannot reach the server.
	 */
	getAccessToken(request: Request): Promise<AccessTokenResult>;
	/**
	 * Runs `fn` with a current access token and appends the refreshed session cookie, if any, to
	 * the `Response` it returns (existing `Set-Cookie` headers are kept). Prefer this over
	 * `getAccessToken` so the cookie is never forgotten.
	 */
	withAccessToken(
		request: Request,
		fn: (context: AccessTokenContext) => Response | Promise<Response>,
	): Promise<{ ok: true; response: Response } | AccessTokenFailure>;
	/**
	 * Advanced: for a custom sign-in flow instead of `handlers`. Returns the authorize URL to
	 * redirect the browser to, plus the values to keep until the callback.
	 */
	startLogin(): Promise<LoginAttempt & { url: URL }>;
	/**
	 * Advanced: exchanges the callback's `code` for tokens (checking `state`, sending the PKCE
	 * verifier) and loads the user. Pair with `startLogin`. A bad callback is a `{ ok: false }` result;
	 * an unreachable server throws `AuthServerUnavailableError`.
	 */
	finishLogin(callbackUrl: URL, attempt: LoginAttempt): Promise<LoginResult>;
}

const TX_MAX_AGE_SECONDS = 600;
const REFRESH_SKEW_SECONDS = 30;

/**
 * `getDiscovery` is the issuer's shared cache, so the client never fetches discovery on its own.
 * Missing or invalid settings throw an `OAuthConfigError` naming each one.
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
