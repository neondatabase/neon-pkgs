import type { RealtimeClient, SealedLiveQuery } from "@neon/realtime/client";
import { createCollection, type WithVirtualProps } from "@tanstack/db";
import { expectTypeOf, it } from "vitest";
import { realtimeCollectionOptions } from "./collection-options.js";

interface TimestampRow {
	id: number;
	created_at: Date;
}

it("infers collection rows from the sealed query, not callbacks", () => {
	// Type-checked during build; no collection or subscription is started.
	function check(
		client: RealtimeClient,
		query: SealedLiveQuery<TimestampRow>,
		weakerQuery: SealedLiveQuery<{ id: number }>,
	) {
		const options = realtimeCollectionOptions({
			client,
			query,
			refreshQuery: async () => query,
			getKey: (row) => {
				expectTypeOf(row).toEqualTypeOf<TimestampRow>();
				return row.id;
			},
			onInsert: async ({ transaction }) => {
				expectTypeOf(
					transaction.mutations[0].modified.created_at,
				).toEqualTypeOf<Date>();
			},
		});
		const collection = createCollection(options);
		expectTypeOf(collection.get(1)).toEqualTypeOf<
			WithVirtualProps<TimestampRow, number> | undefined
		>();
		// @ts-expect-error getKey still infers a number, not string|number.
		collection.get("1");
		realtimeCollectionOptions({
			client,
			query,
			// @ts-expect-error Refresh cannot weaken the query's row type.
			refreshQuery: async () => weakerQuery,
			getKey: (row) => row.id,
		});
		const broadCallback = realtimeCollectionOptions({
			client,
			query,
			getKey: (row: { id: number }) => row.id,
		});
		expectTypeOf(createCollection(broadCallback).get(1)).toEqualTypeOf<
			WithVirtualProps<TimestampRow, number> | undefined
		>();
	}
	expectTypeOf(check).toBeFunction();
});
