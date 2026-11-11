import type { SealedLiveQuery } from "../client/sealed-query.js";
import {
	createEnvelopeIssuer,
	importRealtimePublicKey,
	loadRealtimeKey,
	noRealtimeKeyError,
	type RealtimeFetch,
	type RealtimePublicKey,
	realtimeKeysUrl,
	validateEnvelopeCredential,
	validateEnvelopeUser,
} from "./capability/index.js";
import { prepareRawSqlQuery, type RawSqlQuery } from "./raw-sql.js";

export type { RealtimePublicKey } from "./capability/index.js";

/** Options for {@link fetchRealtimeKey}. */
export interface FetchRealtimeKeyOptions {
	/** `fetch` to use. Defaults to the global `fetch`. */
	readonly fetch?: RealtimeFetch;
}

/**
 * Fetch the branch's current public key from the Realtime endpoint.
 *
 * Low-level, for tooling and tests: it always makes a request, while
 * `createRealtime()` caches the key as the endpoint's `Cache-Control` allows.
 *
 * @param url - Realtime WebSocket (or HTTPS) URL of the branch.
 * @throws If the branch publishes no key, or the request or its answer fails.
 */
export async function fetchRealtimeKey(
	url: string,
	options: FetchRealtimeKeyOptions = {},
): Promise<RealtimePublicKey> {
	const keysUrl = realtimeKeysUrl(url);
	const { key } = await loadRealtimeKey(keysUrl, options.fetch);
	if (!key) throw noRealtimeKeyError(keysUrl);
	return Object.freeze({ ...key.jwk });
}

/** Options for {@link sealRealtimeEnvelope}. */
export interface SealRealtimeEnvelopeOptions<Row> {
	/** Branch public key, from {@link fetchRealtimeKey}. */
	readonly key: RealtimePublicKey;
	/** PostgreSQL database embedded in the envelope. */
	readonly db: string;
	/** Postgres role sealed into `auth.user`. Not limited to `neondb_owner`. */
	readonly user: string;
	/** Password or OIDC token sealed into `auth.credential`. */
	readonly credential: string;
	/** Query created with `rawSql()`. */
	readonly query: RawSqlQuery<Row>;
	/** Request full database error details. @defaultValue false */
	readonly debugMode?: boolean;
}

/**
 * Seal one v3 envelope for an explicit user and credential.
 *
 * Low-level, for tooling and tests, such as checking that the proxy rejects
 * a role other than `neondb_owner`. Applications use `createRealtime()`,
 * which reads the login from `databaseUrl` and caches keys and tokens.
 *
 * @throws If the key, user, credential or database is invalid.
 */
export async function sealRealtimeEnvelope<Row>(
	options: SealRealtimeEnvelopeOptions<Row>,
): Promise<SealedLiveQuery<Row>> {
	validateEnvelopeUser(options.user);
	validateEnvelopeCredential(options.credential);
	const database = new TextEncoder().encode(options.db);
	if (
		database.length === 0 ||
		database.length > 63 ||
		options.db.includes("\0")
	) {
		throw new Error("Invalid Realtime database name");
	}
	const key = await importRealtimePublicKey(options.key);
	const login = Object.freeze({
		user: options.user,
		credential: options.credential,
	});
	const issue = createEnvelopeIssuer({
		login: async () => login,
		database: options.db,
		errorDetails: options.debugMode === true ? "full" : "safe",
	});
	return Object.freeze(
		await issue(prepareRawSqlQuery(options.query), "raw_sql", key),
	) as SealedLiveQuery<Row>;
}
