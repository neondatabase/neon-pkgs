// @vitest-environment jsdom

import {
	createRealtimeClient,
	type SealedLiveQuery,
} from "@neon/realtime/client";
import { renderToString } from "react-dom/server";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
	RealtimeProvider,
	type UseLiveQueryResult,
	useLiveQuery,
} from "./index.js";

interface TimestampRow {
	id: number;
	created_at: Date;
}

/** Representative recursive transformation performed by JSON-aware APIs. */
type JsonTransport<Value> = Value extends string | number | boolean | null
	? Value
	: Value extends Date
		? string
		: Value extends readonly unknown[]
			? { [Key in keyof Value]: JsonTransport<Value[Key]> }
			: Value extends object
				? { [Key in keyof Value]: JsonTransport<Value[Key]> }
				: never;

const query: SealedLiveQuery<TimestampRow> = {
	capability: "unused-during-server-rendering",
	queryFingerprint: "a".repeat(64),
	expiresAt: 2_000_000_000_000,
};
type Payload = JsonTransport<{
	query: SealedLiveQuery<TimestampRow>;
	initialData: readonly TimestampRow[];
}>;
const payload: Payload = {
	query,
	initialData: [{ id: 1, created_at: "2026-10-15T10:00:00.000Z" }],
};

describe("serialized initial data", () => {
	it("preserves decoded rows through JSON transport typing", () => {
		// The package build type-checks this custom hook without rendering it.
		function useTypedRows(payload: Payload) {
			const restored = payload.initialData.map((row) => ({
				...row,
				created_at: new Date(row.created_at),
			}));
			const result = useLiveQuery(payload.query, {
				initialData: restored,
				refreshQuery: async () => payload.query,
			});
			expectTypeOf(result).toEqualTypeOf<
				UseLiveQueryResult<TimestampRow>
			>();
			useLiveQuery(payload.query, {
				// @ts-expect-error JSON date strings are not decoded Date values.
				initialData: payload.initialData,
			});
			return result;
		}
		expectTypeOf(useTypedRows).returns.toEqualTypeOf<
			UseLiveQueryResult<TimestampRow>
		>();
	});

	it("renders application-decoded initial dates immediately during SSR", () => {
		expectTypeOf(payload.initialData[0].created_at).toEqualTypeOf<string>();
		const initialData = payload.initialData.map((row) => ({
			...row,
			created_at: new Date(row.created_at),
		}));
		const client = createRealtimeClient({ url: "ws://unused.invalid" });
		function Timestamps() {
			const { data } = useLiveQuery(payload.query, { initialData });
			expectTypeOf(data).toEqualTypeOf<
				readonly TimestampRow[] | undefined
			>();
			return <span>{data?.[0]?.created_at.toISOString()}</span>;
		}
		try {
			expect(
				renderToString(
					<RealtimeProvider client={client}>
						<Timestamps />
					</RealtimeProvider>,
				),
			).toBe("<span>2026-10-15T10:00:00.000Z</span>");
		} finally {
			client.close();
		}
	});
});
