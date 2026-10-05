/**
 * Seal application-defined PostgreSQL live queries on an application backend.
 *
 * @module Backend
 */

export { encodeTextParameter } from "./server/adapter.js";
export { validateLiveSelectSql } from "./server/query-validation.js";
export { isTypedRawSqlParameter } from "./server/raw-parameter.js";
export type {
	PostgresParameterHelpers,
	PreparedLiveQuery,
	PreparedLiveQueryParameter,
	RawSqlParameter,
	RawSqlQuery,
	RealtimeAdapter,
	RealtimeDirectServer,
	RealtimeDirectServerOptions,
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
