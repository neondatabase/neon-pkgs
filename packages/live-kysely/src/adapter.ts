import {
	type PreparedLiveQuery,
	type RealtimeAdapter,
	validateLiveSelectSql,
} from "@neon/live/server";
import {
	createQueryId,
	PostgresQueryCompiler,
	type SelectQueryNode,
} from "kysely";
import { encodeKyselyParameter } from "./parameter.js";

/** Structural surface required from a concrete Kysely select builder. */
interface KyselySelectQuery {
	/** Kysely's type-only result-row marker. Its runtime value is `undefined`. */
	readonly expressionType: unknown | undefined;
	/** Return the query after Kysely's query-transforming plugins have run. */
	toOperationNode(): { readonly kind: "SelectQueryNode" };
}

/**
 * Prepare concrete Kysely selects as live queries.
 *
 * The adapter compiles Kysely's operation tree with its PostgreSQL compiler,
 * then encodes the raw parameters using node-postgres-compatible rules. It
 * never connects to or executes against the configured Kysely database.
 *
 * @returns An adapter to pass to `createRealtime()` on the application backend.
 */
export function kyselyAdapter(): RealtimeAdapter<KyselySelectQuery> {
	return Object.freeze({
		prepare(query: KyselySelectQuery): PreparedLiveQuery {
			const queryNode = query.toOperationNode();
			if (queryNode.kind !== "SelectQueryNode") {
				throw new Error(
					"Kysely Live requires a concrete select builder",
				);
			}
			const compiled = new PostgresQueryCompiler().compileQuery(
				queryNode as SelectQueryNode,
				createQueryId(),
			);
			validateLiveSelectSql(compiled.sql);
			return Object.freeze({
				sql: compiled.sql,
				parameters: Object.freeze(
					compiled.parameters.map(encodeKyselyParameter),
				),
			});
		},
	});
}
