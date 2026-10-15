import { expectTypeOf, it } from "vitest";
import type { RawSqlQuery, RealtimeDirectServer } from "../server/realtime.js";
import { rawSql } from "../server/realtime.js";
import { QueryRefreshController } from "./query-refresh.js";
import type { SealedLiveQuery } from "./sealed-query.js";
import type {
	MaterializedLiveQuerySubscription,
	RawLiveQuerySubscription,
	RealtimeClient,
} from "./types.js";

interface TimestampRow {
	id: number;
	created_at: Date;
}

it("infers subscription rows from the query, not initial data", () => {
	// Type-checked during build; never subscribe or open a socket here.
	function check(
		client: RealtimeClient,
		query: SealedLiveQuery<TimestampRow>,
		initialData: TimestampRow[],
		unknownRows: unknown[],
		broadRows: { id: number; created_at: Date | string }[],
	) {
		expectTypeOf(client.subscribe(query, { initialData })).toEqualTypeOf<
			MaterializedLiveQuerySubscription<TimestampRow>
		>();
		expectTypeOf(client.subscribe(query)).toEqualTypeOf<
			MaterializedLiveQuerySubscription<TimestampRow>
		>();
		expectTypeOf(
			client.subscribe(query, { materialize: false }),
		).toEqualTypeOf<RawLiveQuerySubscription<TimestampRow>>();
		// @ts-expect-error Missing columns cannot weaken the query's inferred row.
		client.subscribe(query, { initialData: [{ id: 1 }] });
		// @ts-expect-error Unknown initial rows cannot erase the query's row type.
		client.subscribe(query, { initialData: unknownRows });
		// @ts-expect-error Date|string cannot widen the query's Date column.
		client.subscribe(query, { initialData: broadRows });
		// @ts-expect-error Initial data must contain decoded Date values.
		client.subscribe(query, {
			initialData: [{ id: 1, created_at: "2026-10-15" }],
		});
	}
	expectTypeOf(check).toBeFunction();
});

it("keeps direct subscription initial data tied to its SQL query", () => {
	function check(
		direct: RealtimeDirectServer<RawSqlQuery<unknown>>,
		initialData: TimestampRow[],
	) {
		const query = rawSql<TimestampRow>("select id, created_at from items");
		expectTypeOf(
			direct.subscribe(query, { initialData }),
		).resolves.toEqualTypeOf<
			MaterializedLiveQuerySubscription<TimestampRow>
		>();
		// @ts-expect-error Initial data cannot remove columns from the query's row.
		direct.subscribe(query, { initialData: [{ id: 1 }] });
	}
	expectTypeOf(check).toBeFunction();
});

it("does not infer weaker query types from refresh callbacks", () => {
	function check(
		query: SealedLiveQuery<TimestampRow>,
		weakerQuery: SealedLiveQuery<{ id: number }>,
	) {
		const controller = new QueryRefreshController({
			query,
			refreshQuery: async () => query,
			renewSubscription: async (replacement) => {
				expectTypeOf(replacement).toEqualTypeOf<
					SealedLiveQuery<TimestampRow>
				>();
			},
			onRefreshExhausted: () => undefined,
		});
		expectTypeOf(controller.currentQuery()).toEqualTypeOf<
			SealedLiveQuery<TimestampRow>
		>();
		new QueryRefreshController({
			query,
			// @ts-expect-error Refresh cannot erase a column from the initial query.
			refreshQuery: async () => weakerQuery,
			renewSubscription: async () => undefined,
			onRefreshExhausted: () => undefined,
		});
	}
	expectTypeOf(check).toBeFunction();
});
