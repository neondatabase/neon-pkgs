import { decodeBase64UrlStrict, utf8 } from "./crypto.js";
import type { EnvelopeLogin } from "./envelope.js";

const SUPPORTED_USER = "neondb_owner";
const MAX_USER_BYTES = 63;
const MAX_CREDENTIAL_BYTES = 16_384;
// Reuse a token until shortly before it expires. A new token for every
// envelope would miss the proxy's login cache each time.
const TOKEN_REFRESH_MARGIN_SECONDS = 60;

/** Returns the OIDC token sent when the database URL has no password. */
export type OidcTokenSource = () => string | Promise<string>;

export interface DatabaseUrlParts {
	readonly user: string;
	/** Empty when the URL has no password: the credential is an OIDC token. */
	readonly password: string;
	readonly database?: string;
}

/**
 * Read the user, password and database from a Postgres connection string.
 * Errors never include the URL, since it can contain the password.
 */
export function parseDatabaseUrl(databaseUrl: string): DatabaseUrlParts {
	let url: URL;
	try {
		url = new URL(databaseUrl);
	} catch {
		throw new Error("Invalid Realtime databaseUrl");
	}
	if (url.protocol !== "postgresql:" && url.protocol !== "postgres:") {
		throw new Error(
			"Invalid Realtime databaseUrl: use a postgresql:// connection string",
		);
	}
	// Like libpq, query parameters override the userinfo.
	const user =
		url.searchParams.get("user") ?? decodeComponent(url.username, "user");
	const password =
		url.searchParams.get("password") ??
		decodeComponent(url.password, "password");
	const path = decodeComponent(url.pathname.replace(/^\//, ""), "database");
	const database = url.searchParams.get("dbname") ?? (path || undefined);
	return { user, password, ...(database ? { database } : {}) };
}

/** The first release accepts only `neondb_owner`; say so before sealing. */
export function validateLoginUser(user: string): void {
	if (user === "") {
		throw new Error("Invalid Realtime databaseUrl: it has no user");
	}
	if (user !== SUPPORTED_USER) {
		throw new Error(
			"Neon Realtime currently supports only the neondb_owner role",
		);
	}
}

/** Check a user name against the envelope's `auth.user` limits. */
export function validateEnvelopeUser(user: string): void {
	const bytes = utf8(user).length;
	if (bytes === 0 || bytes > MAX_USER_BYTES || user.includes("\0")) {
		throw new Error("Invalid Realtime user");
	}
}

/** Check a password or token against the envelope's `auth.credential` limits. */
export function validateEnvelopeCredential(credential: string): void {
	const bytes = utf8(credential).length;
	if (
		bytes === 0 ||
		bytes > MAX_CREDENTIAL_BYTES ||
		credential.includes("\0")
	) {
		throw new Error("Invalid Realtime credential");
	}
}

/**
 * Supply the login for each envelope: the URL's password, or, when it has
 * none, an OIDC token. An empty password never means "send no credential".
 */
export function createLoginSource(
	parts: DatabaseUrlParts,
	oidcToken: OidcTokenSource | undefined,
	clock: () => number = Date.now,
): () => Promise<EnvelopeLogin> {
	validateLoginUser(parts.user);
	if (oidcToken !== undefined && typeof oidcToken !== "function") {
		throw new Error("Realtime oidcToken must be a function");
	}
	if (parts.password !== "") {
		if (oidcToken !== undefined) {
			throw new Error(
				"Realtime uses oidcToken only when databaseUrl has no password",
			);
		}
		try {
			validateEnvelopeCredential(parts.password);
		} catch {
			throw new Error("Invalid Realtime databaseUrl password");
		}
		const login = Object.freeze({
			user: parts.user,
			credential: parts.password,
		});
		return async () => login;
	}
	const tokens = reusableTokens(oidcToken ?? vercelOidcToken, clock);
	return async () => ({ user: parts.user, credential: await tokens() });
}

const reusers = new WeakMap<OidcTokenSource, () => Promise<string>>();

/** Share one cache per token source, across SDK instances. */
function reusableTokens(
	source: OidcTokenSource,
	clock: () => number,
): () => Promise<string> {
	let reuse = reusers.get(source);
	if (!reuse) {
		reuse = createTokenReuse(source, clock);
		reusers.set(source, reuse);
	}
	return reuse;
}

/** @internal Exported for tests. */
export function createTokenReuse(
	source: OidcTokenSource,
	clock: () => number = Date.now,
): () => Promise<string> {
	let cached:
		| { readonly token: string; readonly refreshAt: number }
		| undefined;
	let pending: Promise<string> | undefined;
	const fetchToken = async (): Promise<string> => {
		// Defer the call so a source that throws synchronously still rejects
		// this promise after `pending` holds it, and the reset below sees it.
		await undefined;
		const token: unknown = await source();
		if (typeof token !== "string") {
			throw new Error("Realtime oidcToken must return a string");
		}
		try {
			validateEnvelopeCredential(token);
		} catch {
			throw new Error("Realtime got an invalid OIDC token");
		}
		const expiresAt = jwtExpiry(token);
		const refreshAt =
			expiresAt === undefined
				? 0
				: (expiresAt - TOKEN_REFRESH_MARGIN_SECONDS) * 1_000;
		cached = clock() < refreshAt ? { token, refreshAt } : undefined;
		return token;
	};
	return () => {
		if (cached && clock() < cached.refreshAt)
			return Promise.resolve(cached.token);
		if (pending) return pending;
		const attempt = fetchToken();
		pending = attempt;
		// Never keep a settled attempt, so a failure is retried on the next call.
		const settled = () => {
			if (pending === attempt) pending = undefined;
		};
		attempt.then(settled, settled);
		return attempt;
	};
}

/** `exp` of a JWT, read without verification; undefined if absent. */
function jwtExpiry(token: string): number | undefined {
	const segments = token.split(".");
	if (segments.length !== 3) return undefined;
	try {
		const payload = JSON.parse(
			new TextDecoder("utf-8", { fatal: true }).decode(
				decodeBase64UrlStrict(segments[1] ?? ""),
			),
		) as unknown;
		if (typeof payload !== "object" || payload === null) return undefined;
		const exp = (payload as { exp?: unknown }).exp;
		return typeof exp === "number" && Number.isFinite(exp)
			? exp
			: undefined;
	} catch {
		return undefined;
	}
}

const VERCEL_REQUEST_CONTEXT = Symbol.for("@vercel/request-context");

interface VercelRequestContext {
	readonly headers?: Record<string, string | undefined>;
}

/**
 * Vercel's runtime OIDC token: the request's `x-vercel-oidc-token` header,
 * then `VERCEL_OIDC_TOKEN`. This mirrors `@vercel/oidc`'s
 * `getVercelOidcTokenSync()`.
 */
export function vercelOidcToken(): string {
	const store = (globalThis as Record<symbol, unknown>)[
		VERCEL_REQUEST_CONTEXT
	] as { get?: () => VercelRequestContext | undefined } | undefined;
	const fromRequest = store?.get?.()?.headers?.["x-vercel-oidc-token"];
	const fromEnv = (
		globalThis as { process?: { env?: Record<string, string | undefined> } }
	).process?.env?.VERCEL_OIDC_TOKEN;
	const token = fromRequest || fromEnv;
	if (!token) {
		throw new Error(
			"databaseUrl has no password, so Realtime sends a Vercel OIDC token, but none is available. Turn on OIDC in the Vercel project, or pass oidcToken.",
		);
	}
	return token;
}

function decodeComponent(value: string, part: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		throw new Error(
			`Invalid Realtime databaseUrl: cannot decode its ${part}`,
		);
	}
}
