/**
 * Seal application-defined PostgreSQL live queries on an application backend.
 *
 * @module Backend
 */

export { encodeTextParameter } from "./server/adapter.js";
export type {
	FetchRealtimeKeyOptions,
	RealtimePublicKey,
	SealRealtimeEnvelopeOptions,
} from "./server/envelope.js";
export {
	fetchRealtimeKey,
	sealRealtimeEnvelope,
} from "./server/envelope.js";
export { isTypedRawSqlParameter } from "./server/raw-parameter.js";
export type {
	OidcTokenSource,
	PostgresParameterHelpers,
	PreparedLiveQuery,
	PreparedLiveQueryParameter,
	RawSqlParameter,
	RawSqlQuery,
	RealtimeAdapter,
	RealtimeAdapterSource,
	RealtimeDatabaseUrlOptions,
	RealtimeDirectServer,
	RealtimeDirectServerOptions,
	RealtimeEndpointOptions,
	RealtimeFetch,
	RealtimeSecretOptions,
	RealtimeServer,
	RealtimeServerOptions,
	SealedLiveQuery,
	TypedRawSqlParameter,
} from "./server/realtime.js";
export {
	createRealtime,
	pgParam,
	rawSql,
} from "./server/realtime.js";
