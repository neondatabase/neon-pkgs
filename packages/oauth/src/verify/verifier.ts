// Per-issuer plumbing shared by everything the factory hands out: one single-flight discovery
// cache and one JWKS resolver, so the verifier, MCP servers and the OAuth client never duplicate fetches.
// Depends on jose only: the MCP and verify entry points must never pull in the sign-in client.

import type { JWTPayload } from "jose";
import { createRemoteJWKSet, errors as joseErrors, jwtVerify } from "jose";

import type { BearerGuard, OAuthBearerOptions } from "./bearer";
import { createBearerGuard } from "./bearer";
import type { InvalidTokenCode } from "./errors";
import {
	AuthServerUnavailableError,
	InvalidTokenError,
	OAuthConfigError,
} from "./errors";

/** Options for verifying Neon Auth access tokens; shared by `createVerifier`, `createOAuth` and `createMcpAuth`. */
export interface VerifierOptions {
	/** The Neon Auth URL, which is the OAuth issuer, e.g. `https://<host>/neondb/auth`. Must be an absolute URL; matched exactly against the token's `iss`. */
	baseUrl: string;
	/**
	 * The API this verifier guards; becomes the token's `aud`. The verifier's `requireBearerAuth()`
	 * verifies against it unless given an explicit `audience`.
	 */
	resource?: string;
	/**
	 * Accepted signature algorithms. Pinned so a token cannot choose its own (algorithm confusion).
	 *
	 * @defaultValue `["EdDSA"]`
	 */
	algorithms?: string[];
	/**
	 * Seconds of clock skew tolerated on `exp` and `nbf`.
	 *
	 * @defaultValue `0`
	 */
	clockTolerance?: number;
	/** Caching of the authorization server's discovery document. */
	discovery?: {
		/**
		 * How long a discovery document is trusted before it is re-fetched, in milliseconds.
		 *
		 * @defaultValue `3_600_000` (1 hour)
		 */
		ttlMs?: number;
		/**
		 * How long a failed discovery attempt is remembered, in milliseconds, so an outage is not hammered.
		 *
		 * @defaultValue `5_000` (5 seconds)
		 */
		failureBackoffMs?: number;
	};
	/** Tuning for the remote signing-key set, passed to jose's `createRemoteJWKSet`. */
	jwks?: {
		/**
		 * Milliseconds after a successful key fetch during which no further fetch is made.
		 *
		 * @defaultValue jose's default, `30_000`
		 */
		cooldownDuration?: number;
		/**
		 * Maximum milliseconds between successful key fetches.
		 *
		 * @defaultValue jose's default, `600_000`
		 */
		cacheMaxAge?: number;
		/**
		 * Milliseconds before a key fetch is aborted; verification then fails as unavailable.
		 *
		 * @defaultValue jose's default, `5_000`
		 */
		timeoutDuration?: number;
	};
}

/** The authorization server's discovery document (RFC 8414 / OpenID Connect). Fields beyond those listed are kept as returned. */
export interface AuthServerMetadata {
	/** The issuer, always equal to the configured `baseUrl` without a trailing slash: a document claiming another issuer is rejected. */
	issuer: string;
	/** Where the signing keys are fetched from. */
	jwks_uri: string;
	/** Whether the server fetches Client ID Metadata Documents, i.e. accepts an https URL as `client_id`. */
	client_id_metadata_document_supported?: boolean;
	[key: string]: unknown;
}

/**
 * The outcome of verifying an access token.
 *
 * A bad token is a result, not an exception: `code` says why and `message` is safe to show in a
 * 401 body. An unreachable authorization server throws `AuthServerUnavailableError` instead.
 */
export type VerifyResult =
	| { ok: true; auth: AuthResult }
	| {
			ok: false;
			reason: "invalid_token";
			code: InvalidTokenCode;
			message: string;
	  };

/** A verified access token, as handed to your handlers. */
export interface AuthResult {
	/** The raw bearer token, for forwarding or for the MCP SDK's `AuthInfo`. */
	token: string;
	/** The authenticated subject (`sub`). Tokens without one are rejected. */
	sub: string;
	/** The OAuth client the token was issued to (`client_id`); `undefined` when the token has no such claim. */
	clientId?: string;
	/** The `scope` claim split on spaces; empty when the token has none. */
	scopes: string[];
	/** The `aud` claim as an array; empty when the token has none. */
	audience: string[];
	/** Expiry (`exp`) in seconds since the epoch. */
	expiresAt?: number;
	/** The full verified JWT payload, for custom claims. */
	claims: JWTPayload;
}

/** What `createVerifier` returns: token verification against one issuer, with a shared discovery and key cache. */
export interface Verifier {
	/** The issuer: `baseUrl` without a trailing slash. */
	readonly issuer: string;
	/**
	 * Returns the authorization server's discovery document, cached for `discovery.ttlMs`.
	 * Concurrent callers share one fetch, and a failure is remembered for `discovery.failureBackoffMs`.
	 *
	 * @returns The discovery document.
	 * @throws {AuthServerUnavailableError} If the server cannot be reached or its document is
	 *   untrusted (issuer mismatch, no `jwks_uri`).
	 */
	getDiscovery(): Promise<AuthServerMetadata>;
	/**
	 * Verifies a raw access token's signature, issuer, expiry and audience. Use it when you read
	 * the `Authorization` header yourself.
	 *
	 * @param token The bearer token, without the `Bearer ` prefix.
	 * @param audience The API identifier the token must have been issued for (its `aud`).
	 * @returns `{ ok: true, auth }`, or `{ ok: false, reason: "invalid_token", code, message }` for a bad token.
	 * @throws {AuthServerUnavailableError} If the discovery document or signing keys cannot be fetched, or
	 *   verification fails for a reason other than the token itself.
	 */
	verifyAccessToken(token: string, audience: string): Promise<VerifyResult>;
	/**
	 * Creates a framework-neutral {@link BearerGuard} for a generic API. Framework guards
	 * (`honoBearerAuth`, `expressBearerAuth`, `withAuth`, ...) are built on it.
	 *
	 * @param options Audience, required scopes and `onError`. See {@link OAuthBearerOptions}.
	 * @returns A guard that never throws.
	 * @throws {OAuthConfigError} If neither `options.audience` nor the verifier's `resource` is set.
	 */
	requireBearerAuth(options?: OAuthBearerOptions): BearerGuard;
}

// Neon Auth serves the first; the second is the OIDC fallback.
const DISCOVERY_PATHS = [
	"/.well-known/oauth-authorization-server",
	"/.well-known/openid-configuration",
];

/**
 * Creates a token verifier for the Neon Auth issuer at `baseUrl`; use it for an API that only
 * accepts tokens and never signs users in.
 *
 * It depends on `jose` alone and never loads the sign-in client. Pass the result to a framework
 * guard such as `honoBearerAuth` or `withAuth`, or call its methods directly. Use
 * `createOAuth` when the same app also signs users in, and `createMcpAuth` for an MCP server.
 * Nothing is fetched until first use, so the app boots while Neon Auth is unreachable.
 *
 * @param options Issuer URL, optional `resource` (the default audience) and verification tuning.
 * @returns A {@link Verifier}.
 * @throws {OAuthConfigError} If `baseUrl` is missing or not an absolute URL.
 *
 * @example
 * ```ts
 * import { Hono } from "hono";
 * import { honoBearerAuth, type AuthVariables } from "@neon/oauth/hono";
 * import { createVerifier } from "@neon/oauth/verify";
 *
 * const verifier = createVerifier({
 *   baseUrl: process.env.NEON_AUTH_BASE_URL!,
 *   resource: "https://api.example.com",
 * });
 *
 * const app = new Hono<AuthVariables>();
 * app.use("/api/*", honoBearerAuth(verifier));
 * app.get("/api/me", (c) => c.json({ user: c.get("auth").sub }));
 * ```
 */
export function createVerifier(options: VerifierOptions): Verifier {
	const baseUrl = options?.baseUrl;
	if (typeof baseUrl !== "string" || baseUrl === "") {
		throw new OAuthConfigError(
			"`baseUrl` is required (the Neon Auth URL, e.g. https://ep-xxx.neonauth.../neondb/auth).",
		);
	}
	if (!URL.canParse(baseUrl)) {
		throw new OAuthConfigError(
			`\`baseUrl\` must be an absolute URL, got "${baseUrl}".`,
		);
	}
	const issuer = baseUrl.replace(/\/$/, "");
	const algorithms = options.algorithms ?? ["EdDSA"];
	const ttlMs = options.discovery?.ttlMs ?? 3_600_000;
	const failureBackoffMs = options.discovery?.failureBackoffMs ?? 5_000;

	// Every discovery failure (network, status, untrusted document) means we cannot trust the server.
	async function fetchDiscovery(): Promise<AuthServerMetadata> {
		try {
			return await fetchDiscoveryDocument();
		} catch (cause) {
			throw new AuthServerUnavailableError(
				cause instanceof Error ? cause.message : String(cause),
				{ cause },
			);
		}
	}

	async function fetchDiscoveryDocument(): Promise<AuthServerMetadata> {
		let notFound: Error | undefined;
		for (const path of DISCOVERY_PATHS) {
			const url = issuer + path;
			const res = await fetch(url, {
				signal: AbortSignal.timeout(10_000),
			});
			if (res.status === 404) {
				notFound = new Error(`Discovery document not found at ${url}`);
				continue;
			}
			if (!res.ok)
				throw new Error(
					`Authorization-server discovery failed: ${res.status} ${res.statusText} (${url})`,
				);
			const doc = (await res.json()) as Partial<AuthServerMetadata>;
			// Without this check, whoever answers at the URL could point us at their own signing keys.
			if (doc.issuer !== issuer) {
				throw new Error(
					`Discovery issuer mismatch: expected "${issuer}", got "${String(doc.issuer)}" (${url})`,
				);
			}
			if (!doc.jwks_uri)
				throw new Error(
					`Discovery document at ${url} is missing "jwks_uri"`,
				);
			return doc as AuthServerMetadata;
		}
		throw (
			notFound ?? new Error(`Discovery document not found at ${issuer}`)
		);
	}

	let cached: { doc: AuthServerMetadata; expiresAt: number } | undefined;
	let inflight: Promise<AuthServerMetadata> | undefined;
	let failure: { error: unknown; until: number } | undefined;

	/** Cached discovery. Concurrent callers share one fetch; failures are remembered only briefly. */
	function getDiscovery(): Promise<AuthServerMetadata> {
		const now = Date.now();
		if (cached && cached.expiresAt > now)
			return Promise.resolve(cached.doc);
		if (failure && failure.until > now)
			return Promise.reject(failure.error);
		inflight ??= fetchDiscovery()
			.then((doc) => {
				cached = { doc, expiresAt: Date.now() + ttlMs };
				failure = undefined;
				return doc;
			})
			.catch((error: unknown) => {
				failure = { error, until: Date.now() + failureBackoffMs };
				throw error;
			})
			.finally(() => {
				inflight = undefined;
			});
		return inflight;
	}

	// Built once per jwks_uri so jose's key cache and cooldown actually work across requests.
	let keys:
		| { uri: string; resolver: ReturnType<typeof createRemoteJWKSet> }
		| undefined;
	async function getKeys() {
		const { jwks_uri } = await getDiscovery();
		if (keys?.uri !== jwks_uri)
			keys = {
				uri: jwks_uri,
				resolver: createRemoteJWKSet(new URL(jwks_uri), options.jwks),
			};
		return keys.resolver;
	}

	async function verifyAccessToken(
		token: string,
		audience: string,
	): Promise<VerifyResult> {
		const resolver = await getKeys();
		try {
			const { payload } = await jwtVerify(token, resolver, {
				// Exact match: branches of a project share signing keys, so the signature
				// alone does not prove the token came from the branch we trust.
				issuer,
				// A token minted for another API must not be replayable here.
				audience,
				algorithms,
				clockTolerance: options.clockTolerance,
			});
			if (typeof payload.sub !== "string" || payload.sub === "") {
				throw new InvalidTokenError(
					"missing_sub",
					'Token is missing the "sub" claim',
				);
			}
			const auth: AuthResult = {
				token,
				sub: payload.sub,
				clientId:
					typeof payload.client_id === "string"
						? payload.client_id
						: undefined,
				scopes:
					typeof payload.scope === "string"
						? payload.scope.split(" ").filter(Boolean)
						: [],
				audience: payload.aud === undefined ? [] : [payload.aud].flat(),
				expiresAt: payload.exp,
				claims: payload,
			};
			return { ok: true, auth };
		} catch (err) {
			const translated = translateVerifyError(err);
			if (translated instanceof InvalidTokenError) {
				return {
					ok: false,
					reason: "invalid_token",
					code: translated.code,
					message: translated.message,
				};
			}
			throw translated;
		}
	}

	/**
	 * Framework-neutral guard for a generic API: the verified result, or a ready 401/403/503/500 `Response`. The guard never throws.
	 * Creating it throws `OAuthConfigError` when neither `options.audience` nor `resource` is set.
	 */
	function requireBearerAuth({
		audience,
		...rest
	}: OAuthBearerOptions = {}): BearerGuard {
		const aud = audience ?? options.resource;
		if (!aud) {
			throw new OAuthConfigError(
				"requireBearerAuth needs an `audience`, or a `resource` passed to createOAuth() / createVerifier().",
			);
		}
		return createBearerGuard(verifier, aud, rest);
	}

	const verifier = {
		issuer,
		getDiscovery,
		verifyAccessToken,
		requireBearerAuth,
	};
	return verifier;
}

function translateVerifyError(err: unknown): Error {
	if (err instanceof InvalidTokenError) return err;
	if (err instanceof joseErrors.JWTExpired)
		return new InvalidTokenError("expired", err.message);
	if (err instanceof joseErrors.JWTClaimValidationFailed) {
		if (err.claim === "aud")
			return new InvalidTokenError("invalid_audience", err.message);
		if (err.claim === "iss")
			return new InvalidTokenError("invalid_issuer", err.message);
	}
	// Fetching keys timed out: the token may be fine, we just cannot tell.
	if (
		err instanceof joseErrors.JWKSTimeout ||
		err instanceof joseErrors.JWKSInvalid ||
		// jose reports a non-200 key-set response as a bare JOSEError.
		(err instanceof joseErrors.JOSEError &&
			err.code === "ERR_JOSE_GENERIC" &&
			/JSON Web Key Set/.test(err.message))
	)
		return new AuthServerUnavailableError(
			"Authorization server unavailable",
			{ cause: err },
		);
	if (err instanceof joseErrors.JOSEError)
		return new InvalidTokenError("invalid_token", err.message);
	return new AuthServerUnavailableError("Token verification failed", {
		cause: err,
	});
}
