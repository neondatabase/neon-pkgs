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

export interface VerifierOptions {
	/** The Neon Auth URL, which is the OAuth issuer, e.g. `https://<host>/neondb/auth`. Matched exactly against token `iss`. */
	baseUrl: string;
	/**
	 * The API this verifier guards; becomes the token's `aud`. `requireBearerAuth()` verifies
	 * against it unless given an explicit `audience`.
	 */
	resource?: string;
	/** Accepted signature algorithms. Defaults to `['EdDSA']`; pinned so a token cannot pick its own (alg confusion). */
	algorithms?: string[];
	/** Seconds of clock skew tolerated on `exp`/`nbf`. */
	clockTolerance?: number;
	discovery?: {
		/** How long a discovery document is trusted before it is re-fetched. Default 1 hour. */
		ttlMs?: number;
		/** How long a failed discovery attempt is remembered, so an outage is not hammered. Default 5 seconds. */
		failureBackoffMs?: number;
	};
	/** Passed to jose's `createRemoteJWKSet`. */
	jwks?: {
		cooldownDuration?: number;
		cacheMaxAge?: number;
		timeoutDuration?: number;
	};
}

export interface AuthServerMetadata {
	issuer: string;
	jwks_uri: string;
	/** Whether the server fetches Client ID Metadata Documents, i.e. accepts an https URL as `client_id`. */
	client_id_metadata_document_supported?: boolean;
	[key: string]: unknown;
}

/** Verification outcome. A bad token is a result; an unreachable server throws `AuthServerUnavailableError`. */
export type VerifyResult =
	| { ok: true; auth: AuthResult }
	| {
			ok: false;
			reason: "invalid_token";
			code: InvalidTokenCode;
			message: string;
	  };

export interface AuthResult {
	/** The raw bearer token, for forwarding or for the MCP SDK's `AuthInfo`. */
	token: string;
	/** The authenticated subject. Tokens without one are rejected. */
	sub: string;
	/** The OAuth client the token was issued to; absent when the token has no `client_id` claim. */
	clientId?: string;
	scopes: string[];
	audience: string[];
	/** Seconds since epoch. */
	expiresAt?: number;
	claims: JWTPayload;
}

// Neon Auth serves the first; the second is the OIDC fallback.
const DISCOVERY_PATHS = [
	"/.well-known/oauth-authorization-server",
	"/.well-known/openid-configuration",
];

export function createVerifier(options: VerifierOptions) {
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
	 * Framework-neutral guard for a generic API: the verified result, or a ready 401/403/503 `Response`. The guard never throws.
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

export type Verifier = ReturnType<typeof createVerifier>;

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
