import type { SealedLiveQuery } from "@neon/realtime/client";
import { expectTypeOf, it } from "vitest";
import { type UseLiveQueryResult, useLiveQuery } from "./index.js";

interface TimestampRow {
	id: number;
	created_at: Date;
}

it("checks preload data and refresh callbacks against the query's row", () => {
	// Type-checked during build; never render or call this hook.
	function useTypedRows(
		query: SealedLiveQuery<TimestampRow>,
		initialData: TimestampRow[],
		unknownRows: unknown[],
		broadRows: { id: number; created_at: Date | string }[],
		weakerQuery: SealedLiveQuery<{ id: number }>,
	) {
		const result = useLiveQuery(query, {
			initialData,
			refreshQuery: async () => query,
		});
		expectTypeOf(result).toEqualTypeOf<UseLiveQueryResult<TimestampRow>>();
		useLiveQuery(query, {
			// @ts-expect-error Missing columns cannot weaken Row.
			initialData: [{ id: 1 }],
		});
		useLiveQuery(query, {
			// @ts-expect-error Unknown rows cannot erase query-derived typing.
			initialData: unknownRows,
		});
		useLiveQuery(query, {
			// @ts-expect-error Date|string cannot widen the query's Date column.
			initialData: broadRows,
		});
		useLiveQuery(query, {
			// @ts-expect-error A refresh cannot drop fields from the live row.
			refreshQuery: async () => weakerQuery,
		});
		return result;
	}
	expectTypeOf(useTypedRows).returns.toEqualTypeOf<
		UseLiveQueryResult<TimestampRow>
	>();
});
