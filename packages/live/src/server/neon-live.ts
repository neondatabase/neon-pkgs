import type { LiveQueryAuthorization } from "../client/authorization.js";
import type { PostgreSQLParsers } from "../client/postgres/parsers.js";
import type {
	MaterializedLiveQueryOptions,
	MaterializedLiveQuerySubscription,
	RawLiveQueryOptions,
	RawLiveQuerySubscription,
} from "../client/types.js";
import {
	type NeonLiveAdapter,
	type PreparedAuthorizationQuery,
	validatePreparedQuery,
} from "./adapter.js";
import {
	createCapabilityIssuer,
	parseNeonLiveSecret,
} from "./capability/index.js";
import { DirectLiveQueryClient } from "./direct-client.js";
import {
	isRawSqlQuery,
	prepareRawSqlQuery,
	type RawSqlQuery,
} from "./raw-sql.js";

export type { LiveQueryAuthorization } from "../client/authorization.js";
export type {
	NeonLiveAdapter,
	PreparedAuthorizationQuery,
	PreparedLiveQueryParameter,
} from "./adapter.js";
export type {
	PostgresParameterHelpers,
	TypedRawSqlParameter,
} from "./raw-parameter.js";
export { pgParam } from "./raw-parameter.js";
export type { RawSqlParameter, RawSqlQuery } from "./raw-sql.js";
export { rawSql } from "./raw-sql.js";

type QueryRow<Query> =
	Query extends RawSqlQuery<infer Row>
		? Row
		: Query extends {
					readonly _: { readonly result: readonly (infer Row)[] };
				}
			? Row
			: never;

type SealInput<Query> = { readonly query: Query };
type AuthorizableQuery<Query> = Query | RawSqlQuery<unknown>;

/**
 * Server-only Neon Live capability issuer.
 *
 * @typeParam Query - Query object accepted by the configured adapter.
 */
export interface NeonLiveServer<Query> {
	/**
	 * Encrypt a concrete query as a short-lived client authorization.
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
	seal<ConcreteQuery extends AuthorizableQuery<Query>>(
		input: SealInput<ConcreteQuery>,
	): Promise<LiveQueryAuthorization<QueryRow<ConcreteQuery>>>;
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
export interface NeonLiveDirectServer<Query> extends NeonLiveServer<Query> {
	/**
	 * Subscribe to a query and retain its current materialized rows.
	 *
	 * @param query - Concrete raw SQL or adapter-native query.
	 * @param options - Materialization and optional preloaded-row settings.
	 * @returns An independently disposable subscription after its initial
	 * capability has been minted locally.
	 * @throws If the query is invalid or the direct client has been closed.
	 */
	subscribe<ConcreteQuery extends AuthorizableQuery<Query>>(
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
	subscribe<ConcreteQuery extends AuthorizableQuery<Query>>(
		query: ConcreteQuery,
		options: RawLiveQueryOptions,
	): Promise<RawLiveQuerySubscription<QueryRow<ConcreteQuery>>>;
	/** Permanently close every direct subscription and the shared WebSocket. */
	close(): void;
}

/**
 * Configuration for a server-only Neon Live capability issuer.
 *
 * @typeParam Query - Query object accepted by the optional adapter.
 */
export interface NeonLiveServerOptions<Query> {
	/** Opaque server-only credential issued by Neon Live. */
	readonly secret: string;
	/**
	 * PostgreSQL database for this SDK instance.
	 *
	 * It is embedded in every query capability. The first capability accepted
	 * on a WebSocket binds that connection to this database.
	 */
	readonly db: string;
	/** Adapter for ORM-native queries; omit when sealing only raw SQL. */
	readonly adapter?: NeonLiveAdapter<Query>;
}

/** Configuration that enables trusted direct-query subscriptions. */
export interface NeonLiveDirectServerOptions<Query>
	extends NeonLiveServerOptions<Query> {
	/**
	 * Neon Live WebSocket endpoint URL. Supplying it adds `subscribe()` and
	 * `close()` to the returned SDK.
	 */
	readonly url: string;
	/** PostgreSQL result-parser overrides for trusted direct subscriptions. */
	readonly parsers?: PostgreSQLParsers;
}

/**
 * Create a server-only Neon Live SDK.
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
export function createNeonLive<Query = RawSqlQuery<unknown>>(
	options: NeonLiveDirectServerOptions<Query>,
): NeonLiveDirectServer<Query>;
export function createNeonLive<Query = RawSqlQuery<unknown>>(
	options: NeonLiveServerOptions<Query>,
): NeonLiveServer<Query>;
export function createNeonLive<Query = RawSqlQuery<unknown>>(
	options: NeonLiveServerOptions<Query> | NeonLiveDirectServerOptions<Query>,
): NeonLiveServer<Query> | NeonLiveDirectServer<Query> {
	const adapter = options.adapter;
	validateDatabaseName(options.db);
	const issueCapability = createCapabilityIssuer(
		parseNeonLiveSecret(options.secret),
		options.db,
	);
	const prepare = <ConcreteQuery extends AuthorizableQuery<Query>>(
		query: ConcreteQuery,
	): PreparedAuthorizationQuery => {
		const prepared = isRawSqlQuery(query)
			? prepareRawSqlQuery(query)
			: prepareWithConfiguredAdapter(query as Query, adapter);
		validatePreparedQuery(prepared);
		return snapshotPreparedQuery(prepared);
	};
	const authorizePrepared = async <Row>(
		prepared: PreparedAuthorizationQuery,
	): Promise<LiveQueryAuthorization<Row>> =>
		Object.freeze(await issueCapability(prepared));
	const seal = async <ConcreteQuery extends AuthorizableQuery<Query>>(
		input: SealInput<ConcreteQuery>,
	): Promise<LiveQueryAuthorization<QueryRow<ConcreteQuery>>> =>
		authorizePrepared<QueryRow<ConcreteQuery>>(prepare(input.query));

	if (!("url" in options)) return Object.freeze({ seal });

	const directClient = new DirectLiveQueryClient(
		options.url,
		options.parsers,
	);
	const subscribe = async <ConcreteQuery extends AuthorizableQuery<Query>>(
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
		const authorization =
			await authorizePrepared<QueryRow<ConcreteQuery>>(prepared);
		return directClient.subscribe(authorization, subscriptionOptions, () =>
			authorizePrepared<QueryRow<ConcreteQuery>>(prepared),
		);
	};

	return Object.freeze({
		seal,
		subscribe,
		close: () => directClient.close(),
	});
}

function snapshotPreparedQuery(
	query: PreparedAuthorizationQuery,
): PreparedAuthorizationQuery {
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
		throw new Error("Invalid Neon Live database name");
	}
}

function prepareWithConfiguredAdapter<Query>(
	query: Query,
	adapter: NeonLiveAdapter<Query> | undefined,
) {
	if (adapter === undefined) {
		throw new Error(
			"Neon Live requires an adapter for queries not created with rawSql()",
		);
	}
	return adapter.prepare(query);
}
