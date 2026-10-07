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
import {
	type PreparedLiveQuery,
	type RealtimeAdapter,
	validatePreparedQuery,
} from "./adapter.js";
import {
	createCapabilityIssuer,
	parseRealtimeSecret,
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
} from "./adapter.js";
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
	 * objects are prepared by the configured adapter.
	 *
	 * @param input - Concrete query to seal.
	 * @returns A JSON-compatible bearer capability with its public fingerprint
	 * and expiry.
	 * @throws If the query is invalid, no adapter can prepare it, or capability
	 * encryption fails.
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
 * remains stale through retryable outages and transparently replaces an
 * expired subscription after connectivity returns.
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
	 * Subscribe to raw resets and atomic change batches without retaining rows.
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
 * Configuration for a server-only Realtime capability issuer.
 *
 * @typeParam Query - Query object accepted by the optional adapter.
 */
export interface RealtimeServerOptions<Query> {
	/** Opaque server-only credential issued by Realtime. */
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

/** Configuration that enables trusted direct-query subscriptions. */
export interface RealtimeDirectServerOptions<Query>
	extends RealtimeServerOptions<Query> {
	/**
	 * Realtime WebSocket endpoint URL. Supplying it adds `subscribe()` and
	 * `close()` to the returned SDK.
	 */
	readonly url: string;
	/** PostgreSQL result-parser overrides for trusted direct subscriptions. */
	readonly parsers?: PostgreSQLParsers;
	/** Minimum diagnostic level for the internal direct-subscription client. */
	readonly logLevel?: RealtimeLogLevel;
	/** Structured diagnostic sink for the internal direct-subscription client. */
	readonly logger?: RealtimeLogger;
}

/**
 * Create a server-only Realtime SDK.
 *
 * `seal()` performs local encryption and no network requests. Supplying a
 * WebSocket `url` additionally enables trusted direct subscriptions that mint
 * and refresh their own capabilities. Keep the project secret out of browser
 * bundles.
 *
 * @typeParam Query - Query object accepted by the configured adapter.
 * @param options - Server-only secret, database name, and optional query
 * adapter.
 * @returns A reusable capability issuer, extended with direct subscriptions
 * when `url` is present.
 * @throws If the secret or database name is invalid.
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
	validateDatabaseName(options.db);
	const issueCapability = createCapabilityIssuer(
		parseRealtimeSecret(options.secret),
		options.db,
		options.debugMode === true ? "full" : "safe",
	);
	const prepare = <ConcreteQuery extends SealableQuery<Query>>(
		query: ConcreteQuery,
	): PreparedLiveQuery => {
		const prepared = isRawSqlQuery(query)
			? prepareRawSqlQuery(query)
			: prepareWithConfiguredAdapter(query as Query, adapter);
		validatePreparedQuery(prepared);
		return snapshotPreparedQuery(prepared);
	};
	const sealPrepared = async <Row>(
		prepared: PreparedLiveQuery,
	): Promise<SealedLiveQuery<Row>> =>
		Object.freeze(await issueCapability(prepared));
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

function validateDatabaseName(database: string): void {
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
