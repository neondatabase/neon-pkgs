import type { PostgreSQLParsers } from "../client/postgres/parsers.js";
import type { SealedLiveQuery } from "../client/sealed-query.js";
import type {
	MaterializedLiveQueryOptions,
	MaterializedLiveQuerySubscription,
	RawLiveQueryOptions,
	RawLiveQuerySubscription,
	RealtimeLogger,
	RealtimeLogLevel,
} from "../client/types.js";
import type {
	PreparedLiveQuery,
	RealtimeAdapter,
	RealtimeAdapterSource,
} from "./adapter.js";
import {
	type CapabilityIssuer,
	cachedRealtimeKey,
	createCapabilityIssuer,
	createEnvelopeIssuer,
	createLoginSource,
	noRealtimeKeyError,
	type OidcTokenSource,
	parseDatabaseUrl,
	parseRealtimeSecret,
	type RealtimeFetch,
	realtimeKeysUrl,
} from "./capability/index.js";
import { DirectLiveQueryClient } from "./direct-client.js";
import {
	isRawSqlQuery,
	prepareRawSqlQuery,
	type RawSqlQuery,
} from "./raw-sql.js";

export type { SealedLiveQuery } from "../client/sealed-query.js";
export type {
	PreparedLiveQuery,
	PreparedLiveQueryParameter,
	RealtimeAdapter,
	RealtimeAdapterSource,
} from "./adapter.js";
export type {
	OidcTokenSource,
	RealtimeFetch,
} from "./capability/index.js";
export type {
	PostgresParameterHelpers,
	TypedRawSqlParameter,
} from "./raw-parameter.js";
export { pgParam } from "./raw-parameter.js";
export type { RawSqlParameter, RawSqlQuery } from "./raw-sql.js";
export { rawSql } from "./raw-sql.js";

type DrizzleQuery<Row> = {
	/** Drizzle stores its inferred result rows on this query marker. */
	readonly _: { readonly result: readonly Row[] };
};

type KyselyQuery<Row> = {
	/** Kysely exposes its inferred result row through this marker. */
	readonly expressionType: Row | undefined;
};

type QueryRow<Query> = Query extends
	| RawSqlQuery<infer Row>
	| DrizzleQuery<infer Row>
	| KyselyQuery<infer Row>
	? Row
	: never;

type SealInput<Query> = { readonly query: Query };
type SealableQuery<Query> = Query | RawSqlQuery<unknown>;
type QuerySource = RealtimeAdapterSource | "raw_sql";

interface PreparedQuery {
	readonly query: PreparedLiveQuery;
	readonly source: QuerySource;
}

/**
 * Server-only Realtime capability issuer.
 *
 * @typeParam Query - Query object accepted by the configured adapter.
 */
export interface RealtimeServer<Query> {
	/**
	 * Encrypt a concrete query as a short-lived sealed query.
	 *
	 * Raw queries produced by {@link rawSql} are always accepted. Other query
	 * objects are prepared by the configured adapter. SQL validation is deferred
	 * to the Realtime proxy when the capability is used.
	 *
	 * @param input - Concrete query to seal.
	 * @returns A JSON-compatible bearer capability with its public fingerprint
	 * and expiry.
	 * @throws If no adapter can prepare the query or capability encryption fails.
	 */
	seal<ConcreteQuery extends SealableQuery<Query>>(
		input: SealInput<ConcreteQuery>,
	): Promise<SealedLiveQuery<QueryRow<ConcreteQuery>>>;
}

/**
 * Server-only SDK with trusted direct-query subscriptions.
 *
 * Each subscription prepares and encrypts its query locally, then uses a
 * shared low-level client and refreshes its capability automatically. It
 * retains its rows while connecting through retryable outages and
 * transparently replaces an expired subscription after connectivity returns.
 *
 * @typeParam Query - Query object accepted by the configured adapter.
 */
export interface RealtimeDirectServer<Query> extends RealtimeServer<Query> {
	/**
	 * Subscribe to a query and retain its current materialized rows.
	 *
	 * @param query - Concrete raw SQL or adapter-native query.
	 * @param options - Materialization and optional preloaded-row settings.
	 * @returns An independently disposable subscription after its initial
	 * capability has been minted locally.
	 * @throws If the query is invalid or the direct client has been closed.
	 */
	subscribe<ConcreteQuery extends SealableQuery<Query>>(
		query: ConcreteQuery,
		options?: MaterializedLiveQueryOptions<QueryRow<ConcreteQuery>>,
	): Promise<MaterializedLiveQuerySubscription<QueryRow<ConcreteQuery>>>;
	/**
	 * Subscribe to complete rows and atomic change batches without retaining rows.
	 *
	 * @param query - Concrete raw SQL or adapter-native query.
	 * @param options - Set `materialize` to `false` to consume raw events.
	 * @returns An independently disposable raw subscription after its initial
	 * capability has been minted locally.
	 * @throws If the query is invalid or the direct client has been closed.
	 */
	subscribe<ConcreteQuery extends SealableQuery<Query>>(
		query: ConcreteQuery,
		options: RawLiveQueryOptions,
	): Promise<RawLiveQuerySubscription<QueryRow<ConcreteQuery>>>;
	/** Permanently close every direct subscription and the shared WebSocket. */
	close(): void;
}

/**
 * Configuration for a seal-only Realtime SDK that uses the legacy secret.
 *
 * To seal envelopes with Postgres credentials instead, pass `databaseUrl` and
 * the Realtime `url` ({@link RealtimeDirectServerOptions}).
 *
 * @typeParam Query - Query object accepted by the optional adapter.
 */
export interface RealtimeServerOptions<Query> {
	/** Legacy shared secret issued by Realtime. */
	readonly secret: string;
	/**
	 * Include full database error details in subscription errors.
	 *
	 * Enable this only in development. Detailed errors can expose schema names,
	 * table names, column names, and other database structure to clients.
	 * @defaultValue false
	 */
	readonly debugMode?: boolean;
	/**
	 * PostgreSQL database for this SDK instance.
	 *
	 * It is embedded in every query capability. The first capability accepted
	 * on a WebSocket binds that connection to this database.
	 */
	readonly db: string;
	/** Adapter for ORM-native queries; omit when sealing only raw SQL. */
	readonly adapter?: RealtimeAdapter<Query>;
}

/** Shared options of an SDK that knows the Realtime endpoint. */
export interface RealtimeEndpointOptions<Query> {
	/**
	 * Realtime WebSocket endpoint URL. Supplying it adds `subscribe()` and
	 * `close()` to the returned SDK. With `databaseUrl`, the SDK also fetches
	 * the branch's public key from this host.
	 */
	readonly url: string;
	/** Include full database error details in subscription errors. */
	readonly debugMode?: boolean;
	/** Adapter for ORM-native queries; omit when sealing only raw SQL. */
	readonly adapter?: RealtimeAdapter<Query>;
	/** PostgreSQL result-parser overrides for trusted direct subscriptions. */
	readonly parsers?: PostgreSQLParsers;
	/** Minimum diagnostic level for the internal direct-subscription client. */
	readonly logLevel?: RealtimeLogLevel;
	/** Structured diagnostic sink for the internal direct-subscription client. */
	readonly logger?: RealtimeLogger;
	/**
	 * `fetch` used to get the branch's public key. Defaults to the global
	 * `fetch`. Pass one for custom TLS, or for runtimes that reject the
	 * request's `cache: "no-store"`.
	 */
	readonly fetch?: RealtimeFetch;
}

/** Seal envelopes with the Postgres login from a connection string. */
export interface RealtimeDatabaseUrlOptions {
	/**
	 * Postgres connection string, such as `DATABASE_URL`. Its user and
	 * password go into each envelope, and the proxy checks them with a
	 * Postgres login. Without a password, the credential is an OIDC token
	 * (see `oidcToken`). Only `neondb_owner` is supported for now.
	 */
	readonly databaseUrl: string;
	/**
	 * Returns the OIDC token to send when `databaseUrl` has no password.
	 * Defaults to Vercel's runtime OIDC token. The SDK reuses a token until
	 * 60 seconds before its `exp`.
	 */
	readonly oidcToken?: OidcTokenSource;
	/** PostgreSQL database. Defaults to the one in `databaseUrl`. */
	readonly db?: string;
	/**
	 * Legacy shared secret, for migration. When the branch publishes no key,
	 * because its Realtime server predates envelopes or its key is not
	 * provisioned yet, the SDK seals legacy tokens with it. It is never used
	 * after an envelope fails.
	 */
	readonly secret?: string;
}

/** Seal legacy tokens with the shared Realtime secret. */
export interface RealtimeSecretOptions {
	/** Legacy shared secret issued by Realtime. */
	readonly secret: string;
	/** PostgreSQL database embedded in every capability. */
	readonly db: string;
	readonly databaseUrl?: undefined;
	readonly oidcToken?: undefined;
}

/**
 * Configuration with a Realtime endpoint: enables direct subscriptions and,
 * with `databaseUrl`, sealing with Postgres credentials, alone or together
 * with the legacy secret during migration.
 */
export type RealtimeDirectServerOptions<Query> =
	RealtimeEndpointOptions<Query> &
		(RealtimeDatabaseUrlOptions | RealtimeSecretOptions);

type AnyRealtimeOptions<Query> = RealtimeServerOptions<Query> &
	Partial<RealtimeEndpointOptions<Query>> & {
		readonly databaseUrl?: string;
		readonly oidcToken?: OidcTokenSource;
	};

/**
 * Create a server-only Realtime SDK.
 *
 * With `databaseUrl`, the SDK looks up the branch's public key at `url` and
 * caches the answer. If the branch publishes a key, each capability is a v3
 * envelope sealed to it, carrying the Postgres login. If it publishes none
 * (an older Realtime server, or a key not provisioned yet), the SDK uses
 * `secret` when one is configured and raises an error otherwise. With only
 * the legacy `secret`, `seal()` encrypts locally and makes no network
 * requests. A WebSocket `url` also enables
 * trusted direct subscriptions that mint and refresh their own capabilities.
 * Keep credentials out of browser bundles.
 *
 * @typeParam Query - Query object accepted by the configured adapter.
 * @param options - Credentials, database name, and optional query adapter.
 * @returns A reusable capability issuer, extended with direct subscriptions
 * when `url` is present.
 * @throws If the credentials, URL or database name are invalid, or if the
 * database URL's user is not `neondb_owner`.
 */
export function createRealtime<Query = RawSqlQuery<unknown>>(
	options: RealtimeDirectServerOptions<Query>,
): RealtimeDirectServer<Query>;
export function createRealtime<Query = RawSqlQuery<unknown>>(
	options: RealtimeServerOptions<Query>,
): RealtimeServer<Query>;
export function createRealtime<Query = RawSqlQuery<unknown>>(
	options: RealtimeServerOptions<Query> | RealtimeDirectServerOptions<Query>,
): RealtimeServer<Query> | RealtimeDirectServer<Query> {
	const adapter = options.adapter;
	const issueCapability = createIssuer(options as AnyRealtimeOptions<Query>);
	const prepare = <ConcreteQuery extends SealableQuery<Query>>(
		query: ConcreteQuery,
	): PreparedQuery => {
		if (isRawSqlQuery(query)) {
			return {
				query: snapshotPreparedQuery(prepareRawSqlQuery(query)),
				source: "raw_sql",
			};
		}
		return {
			query: snapshotPreparedQuery(
				prepareWithConfiguredAdapter(query as Query, adapter),
			),
			source: normalizeAdapterSource(adapter?.querySource),
		};
	};
	const sealPrepared = async <Row>(
		prepared: PreparedQuery,
	): Promise<SealedLiveQuery<Row>> =>
		Object.freeze(await issueCapability(prepared.query, prepared.source));
	const seal = async <ConcreteQuery extends SealableQuery<Query>>(
		input: SealInput<ConcreteQuery>,
	): Promise<SealedLiveQuery<QueryRow<ConcreteQuery>>> =>
		sealPrepared<QueryRow<ConcreteQuery>>(prepare(input.query));

	if (!("url" in options)) return Object.freeze({ seal });

	const directClient = new DirectLiveQueryClient({
		url: options.url,
		parsers: options.parsers,
		logLevel: options.logLevel,
		logger: options.logger,
	});
	const subscribe = async <ConcreteQuery extends SealableQuery<Query>>(
		query: ConcreteQuery,
		subscriptionOptions?:
			| MaterializedLiveQueryOptions<QueryRow<ConcreteQuery>>
			| RawLiveQueryOptions,
	): Promise<
		| MaterializedLiveQuerySubscription<QueryRow<ConcreteQuery>>
		| RawLiveQuerySubscription<QueryRow<ConcreteQuery>>
	> => {
		directClient.assertOpen();
		const prepared = prepare(query);
		const sealedQuery =
			await sealPrepared<QueryRow<ConcreteQuery>>(prepared);
		return directClient.subscribe(sealedQuery, subscriptionOptions, () =>
			sealPrepared<QueryRow<ConcreteQuery>>(prepared),
		);
	};

	return Object.freeze({
		seal,
		subscribe,
		close: () => directClient.close(),
	});
}

/**
 * With a credential, seal v3 when the branch publishes a key, and use the
 * secret only when it definitely publishes none. Without a credential, use
 * the secret. A failed or unreadable key lookup never falls back.
 */
function createIssuer<Query>(
	options: AnyRealtimeOptions<Query>,
): CapabilityIssuer {
	const errorDetails = options.debugMode === true ? "full" : "safe";
	if (options.databaseUrl === undefined) {
		if (options.oidcToken !== undefined) {
			throw new Error("Realtime uses oidcToken only with databaseUrl");
		}
		if (options.secret === undefined) {
			throw new Error("Realtime requires databaseUrl or secret");
		}
		validateDatabaseName(options.db);
		return createCapabilityIssuer(
			parseRealtimeSecret(options.secret),
			options.db,
			errorDetails,
		);
	}
	const login = parseDatabaseUrl(options.databaseUrl);
	const loginSource = createLoginSource(login, options.oidcToken);
	const database = options.db ?? login.database;
	validateDatabaseName(database);
	if (typeof options.url !== "string" || options.url === "") {
		throw new Error(
			"Realtime requires url with databaseUrl, to fetch the branch key",
		);
	}
	const legacy =
		options.secret === undefined
			? undefined
			: createCapabilityIssuer(
					parseRealtimeSecret(options.secret),
					database,
					errorDetails,
				);
	const sealEnvelope = createEnvelopeIssuer({
		login: loginSource,
		database,
		errorDetails,
	});
	const keysUrl = realtimeKeysUrl(options.url);
	const fetchImpl = options.fetch;
	return async (query, querySource = "custom") => {
		const key = await cachedRealtimeKey(keysUrl, fetchImpl);
		if (key) return sealEnvelope(query, querySource, key);
		if (legacy) return legacy(query, querySource);
		throw noRealtimeKeyError(keysUrl);
	};
}

function normalizeAdapterSource(source: unknown): RealtimeAdapterSource {
	return source === "drizzle" || source === "kysely" || source === "custom"
		? source
		: "custom";
}

function snapshotPreparedQuery(query: PreparedLiveQuery): PreparedLiveQuery {
	return Object.freeze({
		sql: query.sql,
		parameters: Object.freeze(
			query.parameters.map((parameter) =>
				Object.freeze({ ...parameter }),
			),
		),
	});
}

function validateDatabaseName(
	database: string | undefined,
): asserts database is string {
	if (typeof database !== "string") {
		throw new Error("Invalid Realtime database name");
	}
	const bytes = new TextEncoder().encode(database);
	if (bytes.length === 0 || bytes.length > 63 || database.includes("\0")) {
		throw new Error("Invalid Realtime database name");
	}
}

function prepareWithConfiguredAdapter<Query>(
	query: Query,
	adapter: RealtimeAdapter<Query> | undefined,
) {
	if (adapter === undefined) {
		throw new Error(
			"Realtime requires an adapter for queries not created with rawSql()",
		);
	}
	return adapter.prepare(query);
}
