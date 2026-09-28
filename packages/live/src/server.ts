/**
 * Authorize application-defined PostgreSQL queries as Neon Live capabilities.
 *
 * @module Backend
 */

export { encodeTextParameter } from "./server/adapter.js";
export type {
	LiveQueryAuthorization,
	NeonLiveAdapter,
	NeonLiveDirectServer,
	NeonLiveDirectServerOptions,
	NeonLiveServer,
	NeonLiveServerOptions,
	PostgresParameterHelpers,
	PreparedAuthorizationQuery,
	PreparedLiveQueryParameter,
	RawSqlParameter,
	RawSqlQuery,
	TypedRawSqlParameter,
} from "./server/neon-live.js";
export {
	createNeonLive,
	pgParam,
	rawSql,
} from "./server/neon-live.js";
export { validateLiveSelectSql } from "./server/query-validation.js";
